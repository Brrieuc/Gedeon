const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { IgApiClient } = require('instagram-private-api');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const cron = require('node-cron');
require('dotenv').config();
const firebase = require('firebase/compat/app');
require('firebase/compat/firestore');

// ── Sécurité globale : ne jamais laisser crasher le process ──────────────────
process.on('uncaughtException', (err) => {
    console.error('[CRASH] Exception non catchée :', err.message);
});
process.on('unhandledRejection', (reason) => {
    console.error('[CRASH] Promesse rejetée non catchée :', reason);
});

// ── Firebase ─────────────────────────────────────────────────────────────────
const firebaseConfig = {
    apiKey: "AIzaSyBNkbLMeK5sTDXW8-NvMdZ-5VZTL_a0X6o",
    authDomain: "gedeon-larbin.firebaseapp.com",
    projectId: "gedeon-larbin",
    storageBucket: "gedeon-larbin.firebasestorage.app",
    messagingSenderId: "750672153668",
    appId: "1:750672153668:web:1537bebe32799e71590011"
};
const app_firebase = firebase.apps.length ? firebase.app() : firebase.initializeApp(firebaseConfig);
const db = app_firebase.firestore();
db.collection('test').limit(1).get()
    .then(() => console.log('[FIREBASE] Connexion Firestore OK'))
    .catch(err => console.error('[FIREBASE] Erreur:', err.message));

// ── Express / Socket.IO ───────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e7, cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// ── État global ───────────────────────────────────────────────────────────────
let wpClient    = null;
let wpReady     = false;
let isBotWorking = false;
let forceStop   = false;
let globalGroups = [];

let igClient    = null;
let isIgWorking = false;
let forceStopIg = false;
let lastKnownUid  = null;   // Dernier uid connu — pour le cron auto-unfollow
let lastIgConfig  = null;   // Dernière config IG (règles unfollow)

// ── Anti-sleep cross-platform — empêche la mise en veille pendant les campagnes
let caffeinateProc = null;
function startCaffeinate() {
    if (caffeinateProc) return;
    if (process.platform === 'darwin') {
        // macOS : caffeinate -dims (display + idle + disk + system sleep)
        caffeinateProc = spawn('caffeinate', ['-dims'], { detached: false, stdio: 'ignore' });
        console.log('[SYS] Mise en veille désactivée (caffeinate macOS)');
    } else if (process.platform === 'win32') {
        // Windows : SetThreadExecutionState via PowerShell
        // ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x00000001) = 0x80000001
        const ps = [
            'Add-Type -Name PwrMgmt -Namespace Win32 -MemberDefinition',
            '"[DllImport(\\"kernel32.dll\\")] public static extern uint SetThreadExecutionState(uint f);";',
            '[Win32.PwrMgmt]::SetThreadExecutionState(0x80000001);',
            'while($true){Start-Sleep 3600}'
        ].join(' ');
        caffeinateProc = spawn('powershell', ['-NoProfile', '-Command', ps], {
            detached: false, stdio: 'ignore'
        });
        console.log('[SYS] Mise en veille désactivée (PowerShell Windows)');
    }
}
function stopCaffeinate() {
    if (!caffeinateProc) return;
    try { caffeinateProc.kill(); } catch (_) {}
    caffeinateProc = null;
    console.log('[SYS] Mise en veille réactivée');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function formatNom(nom) {
    if (!nom) return "l'ami(e)";
    return (nom.split(' ')[0] || nom).trim();
}

const getChromePath = () => {
    if (process.platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (process.platform === 'win32') {
        const candidates = [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            (process.env.LOCALAPPDATA || '') + '\\Google\\Chrome\\Application\\chrome.exe'
        ];
        return candidates.find(p => fs.existsSync(p));
    }
    return undefined;
};

function clearChromeLocks() {
    const sessionDir = path.join(__dirname, '.wwebjs_auth', 'session');
    if (!fs.existsSync(sessionDir)) return;
    ['SingletonLock', 'SingletonSocket', 'SingletonCookie'].forEach(f => {
        const p = path.join(sessionDir, f);
        if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch (_) {} }
    });
}

async function getUidFromToken(data) {
    if (!data) return null;
    const uid = typeof data === 'string' ? data : data.uid;
    if (!uid || uid === 'anonymous') return null;
    return uid;
}

// ── Firestore helpers ─────────────────────────────────────────────────────────
async function getCampaigns(uid) {
    const snap = await db.collection('campaigns').where('userId', '==', uid).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function saveCampaign(uid, data) {
    const { idToken, uid: _u, ...payload } = data;
    payload.userId = uid;
    payload.updatedAt = Date.now();
    if (data.id) {
        await db.collection('campaigns').doc(data.id).set(payload, { merge: true });
        return data.id;
    }
    const ref = await db.collection('campaigns').add(payload);
    return ref.id;
}

async function getHistory(uid, groupId) {
    const doc = await db.collection('history').doc(`${uid}_${groupId}`).get();
    return doc.exists ? doc.data().participants : [];
}

async function updateHistory(uid, groupId, participantId) {
    await db.collection('history').doc(`${uid}_${groupId}`).set({
        userId: uid, groupId,
        participants: firebase.firestore.FieldValue.arrayUnion(participantId),
        lastUpdate: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
}

async function saveIgAction(uid, targetUsername) {
    await db.collection('instagram_actions').add({
        userId: uid, targetUsername,
        action: 'FOLLOW', timestamp: Date.now(), unfollowed: false
    });
}

async function getAllPendingFollows(uid) {
    const snap = await db.collection('instagram_actions')
        .where('userId', '==', uid)
        .where('action', '==', 'FOLLOW')
        .where('unfollowed', '==', false).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function markAsUnfollowed(docId) {
    await db.collection('instagram_actions').doc(docId).update({ unfollowed: true });
}

// ════════════════════════════════════════════════════════════════════════════════
// INSTAGRAM CLIENT
// ════════════════════════════════════════════════════════════════════════════════
class InstagramClient {
    constructor() {
        this.ig = new IgApiClient();
        this.isConnected = false;
        this.username = null;
        this.password = null;
        this.sessionPath    = path.join(__dirname, '.ig_session.json');
        this.credsPath      = path.join(__dirname, '.ig_creds.json');
        this.browserDataDir = path.join(__dirname, '.ig_browser');
        this.browser = null;
        this.page    = null;
    }

    log(msg, type = 'info') {
        io.emit('log_ig', { msg, type });
        console.log(`[IG] ${msg}`);
    }

    async saveSession() {
        try {
            const state = await this.ig.state.serialize();
            delete state.constants;
            fs.writeFileSync(this.sessionPath, JSON.stringify(state));
            if (this.username && this.password) {
                fs.writeFileSync(this.credsPath, JSON.stringify({ username: this.username, password: this.password }));
            }
        } catch (e) {
            this.log('Impossible de sauvegarder la session : ' + e.message, 'warn');
        }
    }

    async loadSession() {
        try {
            if (!fs.existsSync(this.sessionPath)) return false;
            const state = JSON.parse(fs.readFileSync(this.sessionPath, 'utf8'));
            await this.ig.state.deserialize(state);
            if (fs.existsSync(this.credsPath)) {
                const creds = JSON.parse(fs.readFileSync(this.credsPath, 'utf8'));
                this.username = creds.username;
                this.password = creds.password;
            }
            return true;
        } catch (e) {
            this.log('Session précédente invalide.', 'warn');
            return false;
        }
    }

    async init() {
        this.log('Vérification de la session Instagram...');
        const hasSession = await this.loadSession();
        if (hasSession) {
            try {
                const user = await this.ig.account.currentUser();
                this.username = user.username;
                this.isConnected = true;

                // Si on a les credentials, re-login silencieux pour rafraîchir le token CSRF
                // (évite les 404 sur friendship.create lors d'une session restaurée depuis fichier)
                if (this.password) {
                    try {
                        this.log('Rafraîchissement des tokens...', 'system');
                        await this.ig.account.login(this.username, this.password);
                        await this.saveSession();
                        this.log('Tokens rafraîchis — follows activés.', 'success');
                    } catch (refreshErr) {
                        this.log(`Tokens non rafraîchis (${refreshErr.message}). Reconnectez-vous si les follows échouent.`, 'warn');
                    }
                } else {
                    this.log('Pas de credentials sauvegardés — reconnectez-vous une fois pour activer les follows.', 'warn');
                }

                this.log(`Connecté en tant que @${this.username}`, 'success');
                io.emit('ig_status', { state: 'CONNECTED', desc: 'Connecté', username: this.username });
                return;
            } catch (e) {
                this.log('Session expirée, reconnexion requise.', 'warn');
            }
        }
        io.emit('ig_status', { state: 'DISCONNECTED', desc: 'Déconnecté' });
    }

    async login(username, password) {
        try {
            this.log(`Connexion en tant que @${username}...`);
            this.ig.state.generateDevice(username);
            const logged = await this.ig.account.login(username, password);
            this.username = logged.username;
            this.password = password;
            this.isConnected = true;
            process.nextTick(async () => {
                try { await this.ig.simulate.postLoginFlow(); } catch (_) {}
            });
            await this.saveSession();
            this.log(`Connecté en tant que @${this.username}`, 'success');
            io.emit('ig_status', { state: 'CONNECTED', desc: 'Connecté', username: this.username });
            return { success: true };
        } catch (e) {
            const msg = e.message || 'Erreur inconnue';
            if (e.name === 'IgCheckpointError' || msg.includes('checkpoint_required')) {
                try {
                    await this.ig.challenge.auto(true);
                    io.emit('ig_code_required', true);
                    return { success: true, codeRequired: true };
                } catch (ce) {
                    return { success: false, message: 'Instagram bloque la connexion. Réessayez dans quelques minutes.' };
                }
            }
            if (e.name === 'IgLoginBadPasswordError') return { success: false, message: 'Mot de passe incorrect.' };
            if (e.name === 'IgLoginInvalidUserError') return { success: false, message: 'Nom d\'utilisateur introuvable.' };
            this.log(`Erreur : ${msg}`, 'error');
            return { success: false, message: msg };
        }
    }

    async submitCode(code) {
        try {
            await this.ig.challenge.sendSecurityCode(code);
            const user = await this.ig.account.currentUser();
            this.username = user.username;
            this.isConnected = true;
            await this.saveSession();
            this.log(`Code accepté — connecté en tant que @${this.username}`, 'success');
            io.emit('ig_status', { state: 'CONNECTED', desc: 'Connecté', username: this.username });
            return { success: true };
        } catch (e) {
            return { success: false, message: e.message };
        }
    }

    async checkStatus() {
        if (!this.isConnected) { io.emit('ig_status', { state: 'DISCONNECTED', desc: 'Déconnecté' }); return; }
        try {
            const user = await this.ig.account.currentUser();
            this.username = user.username;
            io.emit('ig_status', { state: 'CONNECTED', desc: 'Connecté', username: this.username });
        } catch (e) {
            this.isConnected = false;
            io.emit('ig_status', { state: 'DISCONNECTED', desc: 'Déconnecté' });
        }
    }

    async logout() {
        try { await this.ig.account.logout(); } catch (_) {}
        [this.sessionPath, this.credsPath].forEach(p => { if (fs.existsSync(p)) fs.unlinkSync(p); });
        this.isConnected = false;
        this.username = null;
        io.emit('ig_status', { state: 'DISCONNECTED', desc: 'Déconnecté' });
    }

    async scrapeFollowers(targetUsername, count = 200) {
        try {
            this.log(`Scraping des abonnés de @${targetUsername}...`);
            const userId = await this.ig.user.getIdByUsername(targetUsername.replace('@', ''));
            const feed = this.ig.feed.accountFollowers(userId);
            const results = [];
            do {
                const page = await feed.items();
                results.push(...page.map(u => u.username));
                this.log(`${results.length} abonnés récupérés...`);
                if (results.length >= count) break;
                await sleep(1500 + Math.random() * 1000);
            } while (feed.isMoreAvailable());
            const final = results.slice(0, count);
            this.log(`Scraping terminé : ${final.length} abonnés.`, 'success');
            io.emit('ig_scraped_data', final);
            return final;
        } catch (e) {
            this.log(`Erreur scraping : ${e.message}`, 'error');
            return [];
        }
    }

    // ── Puppeteer browser (pour follow/unfollow via web) ──────────────────────

    async launchBrowser() {
        // Nettoyer les locks Chrome
        ['SingletonLock', 'SingletonSocket', 'SingletonCookie'].forEach(f => {
            const p = path.join(this.browserDataDir, f);
            if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch (_) {}
        });

        this.browser = await puppeteer.launch({
            headless: true,
            executablePath: getChromePath(),
            userDataDir: this.browserDataDir,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled'
            ]
        });
        const pages = await this.browser.pages();
        this.page = pages[0] || await this.browser.newPage();
        // UA desktop — évite la bannière "Open Instagram" qui masque le bouton Follow
        await this.page.setUserAgent(
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        );
        await this.page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1, isMobile: false });
        this.log('Navigateur Instagram lancé.', 'system');
    }

    async closeBrowser() {
        if (this.browser) {
            await this.browser.close().catch(() => {});
            this.browser = null;
            this.page = null;
        }
    }

    async ensureWebLoggedIn() {
        const COOKIE_LABELS = ['Allow all cookies', 'Tout accepter', 'Decline optional cookies', 'Tout refuser'];

        // Helper : screenshot vers /tmp pour debug
        const screenshot = async (label) => {
            const p = `/tmp/ig_${label}.png`;
            await this.page.screenshot({ path: p }).catch(() => {});
            this.log(`[debug] screenshot → ${p}`, 'system');
        };

        // Helper : dismiss cookie banner si présent
        const dismissCookies = async () => {
            const clicked = await this.page.evaluate((labels) => {
                const btn = Array.from(document.querySelectorAll('button, [role="button"]'))
                    .find(el => labels.includes(el.textContent.trim()));
                if (btn) { btn.click(); return true; }
                return false;
            }, COOKIE_LABELS);
            if (clicked) await sleep(2000);
            return clicked;
        };

        // Helper : détecter l'état réel de la page (state machine)
        const detectState = async () => {
            return this.page.evaluate((cLabels) => {
                const allText = Array.from(document.querySelectorAll('a, button, [role="button"], span'))
                    .map(el => el.textContent.trim());

                // 1. Cookie banner d'abord
                if (allText.some(t => cLabels.includes(t)))
                    return 'cookie_banner';

                // 2. Login form : URL OU présence d'un champ password
                //    (priorité sur le texte "Log in" qui apparaît aussi sur la page de login)
                const url = window.location.href;
                if (url.includes('/accounts/login') || url.includes('/login/') ||
                    document.querySelector('input[type="password"]'))
                    return 'login_form';

                // 3. Connecté : éléments exclusifs aux sessions actives
                if (document.querySelector('a[href="/direct/inbox/"]') ||
                    document.querySelector('svg[aria-label="Home"]') ||
                    document.querySelector('svg[aria-label="Accueil"]') ||
                    document.querySelector('a[href="/explore/"]'))
                    return 'logged_in';

                // 4. Login wall (page d'accueil non-connecté)
                if (allText.some(t => ['Log in', 'Se connecter', 'Sign up', "S'inscrire"].includes(t)))
                    return 'login_wall';

                return 'unknown';
            }, COOKIE_LABELS);
        };

        try {
            // ── Étape 1 : page d'accueil ─────────────────────────────────────────
            this.log('[web] chargement instagram.com...', 'system');
            await this.page.goto('https://www.instagram.com/', { waitUntil: 'networkidle2', timeout: 35000 });
            await sleep(2500);

            let state = await detectState();
            this.log(`[web] état initial : ${state}`, 'system');
            await screenshot(`01_initial_${state}`);

            if (state === 'cookie_banner') {
                await dismissCookies();
                state = await detectState();
                this.log(`[web] après cookies : ${state}`, 'system');
                await screenshot(`02_after_cookies_${state}`);
            }

            if (state === 'logged_in') {
                this.log('Session web Instagram active ✓', 'success');
                return true;
            }

            // ── Étape 2 : besoin de se connecter ─────────────────────────────────
            if (!this.username || !this.password) {
                this.log('Aucun credential — connectez-vous depuis le dashboard.', 'error');
                return false;
            }

            this.log('[web] navigation vers /accounts/login/ ...', 'system');
            await this.page.goto('https://www.instagram.com/accounts/login/', {
                waitUntil: 'networkidle2', timeout: 35000
            });
            await sleep(2000);

            state = await detectState();
            this.log(`[web] état page login : ${state}`, 'system');
            await screenshot(`03_login_page_${state}`);

            if (state === 'cookie_banner') {
                await dismissCookies();
                state = await detectState();
                await screenshot(`04_login_after_cookies_${state}`);
            }

            if (state !== 'login_form') {
                this.log(`[web] formulaire login introuvable (état: ${state}) — abandon.`, 'error');
                return false;
            }

            // ── Étape 3 : remplir le formulaire ──────────────────────────────────
            this.log(`[web] connexion en tant que @${this.username}...`, 'system');
            // Sélecteur large : 1er input non-password (Instagram change régulièrement name="username")
            const usernameSelector = 'input:not([type="password"]):not([type="hidden"]):not([type="submit"])';
            await this.page.waitForSelector(usernameSelector, { timeout: 8000 });
            await this.page.click(usernameSelector);
            await this.page.type(usernameSelector, this.username, { delay: 80 + Math.random() * 40 });
            await sleep(600 + Math.random() * 400);
            await this.page.type('input[type="password"]', this.password, { delay: 80 + Math.random() * 40 });
            await sleep(600 + Math.random() * 400);
            // Soumettre via Enter (plus robuste que chercher button[type="submit"])
            await this.page.keyboard.press('Enter');
            await sleep(7000);

            state = await detectState();
            this.log(`[web] état après submit : ${state}`, 'system');
            await screenshot(`05_after_submit_${state}`);

            if (state === 'cookie_banner') {
                await dismissCookies();
                state = await detectState();
            }

            // Fermer popups post-login
            for (let i = 0; i < 4; i++) {
                const dismissed = await this.page.evaluate(() => {
                    const btn = Array.from(document.querySelectorAll('button'))
                        .find(b => ['Not Now', 'Pas maintenant', 'Not now', 'Plus tard', 'Skip'].includes(b.textContent.trim()));
                    if (btn) { btn.click(); return true; }
                    return false;
                });
                if (!dismissed) break;
                await sleep(1500);
            }

            state = await detectState();
            this.log(`[web] état final : ${state}`, 'system');
            await screenshot(`06_final_${state}`);

            if (state === 'logged_in') {
                this.log('Connecté au web Instagram ✓', 'success');
                return true;
            }

            this.log(`[web] connexion échouée (état final: ${state})`, 'error');
            return false;

        } catch (e) {
            this.log(`Erreur connexion web : ${e.message}`, 'error');
            await screenshot('error').catch(() => {});
            return false;
        }
    }

    async followUser(username) {
        if (!this.browser || !this.page) {
            return { success: false, message: 'Navigateur non lancé.' };
        }
        const COOKIE_LABELS = ['Allow all cookies', 'Tout accepter', 'Decline optional cookies', 'Tout refuser'];
        const FOLLOW_LABELS  = ['Follow', 'Suivre', 'Follow Back', 'Suivre en retour'];
        const FOLLOWING_LABELS = ['Following', 'Abonné(e)', 'Requested', 'Demandé(e)'];

        try {
            await this.page.goto(`https://www.instagram.com/${username}/`, {
                waitUntil: 'networkidle2',
                timeout: 40000
            });

            // Étape 1 : attendre que quelque chose d'utile apparaisse (cookie banner OU bouton Follow)
            await this.page.waitForFunction((cLabels, fLabels, flLabels) => {
                const all = Array.from(document.querySelectorAll('button, [role="button"]'));
                const texts = all.map(el => el.textContent.trim());
                return texts.some(t => [...cLabels, ...fLabels, ...flLabels].includes(t));
            }, { timeout: 15000 }, COOKIE_LABELS, FOLLOW_LABELS, FOLLOWING_LABELS).catch(() => {});

            // Étape 2 : dismisser le cookie banner s'il est là
            const hadCookie = await this.page.evaluate((cLabels) => {
                const btn = Array.from(document.querySelectorAll('button, [role="button"]'))
                    .find(el => cLabels.includes(el.textContent.trim()));
                if (btn) { btn.click(); return true; }
                return false;
            }, COOKIE_LABELS);

            if (hadCookie) {
                // Attendre que le banner disparaisse et que le Follow button apparaisse
                await this.page.waitForFunction((fLabels, flLabels) => {
                    const all = Array.from(document.querySelectorAll('button, [role="button"]'));
                    return all.some(el => [...fLabels, ...flLabels].includes(el.textContent.trim()));
                }, { timeout: 12000 }, FOLLOW_LABELS, FOLLOWING_LABELS).catch(() => {});
            }

            await sleep(600 + Math.random() * 400);

            // Étape 3 : cliquer sur Follow
            const result = await this.page.evaluate((fLabels, flLabels) => {
                const all = Array.from(document.querySelectorAll('button, [role="button"]'));
                const followEl = all.find(el => fLabels.includes(el.textContent.trim()));
                if (followEl) { followEl.click(); return { found: true }; }
                const already = all.some(el => flLabels.includes(el.textContent.trim()));
                const texts = all.slice(0, 20).map(el => el.textContent.trim().substring(0, 40)).filter(Boolean);
                return { found: false, already, texts };
            }, FOLLOW_LABELS, FOLLOWING_LABELS);

            if (!result.found && !result.already && result.texts?.length) {
                this.log(`[debug @${username}] ${result.texts.join(' | ')}`, 'system');
            }

            if (result.already) return { success: true, already: true };
            if (!result.found)  return { success: false, message: 'Bouton Follow introuvable.' };

            await sleep(1000);
            return { success: true };
        } catch (e) {
            return { success: false, message: e.message };
        }
    }

    async unfollowUser(username) {
        if (!this.browser || !this.page) {
            // Fallback API si pas de browser
            try {
                const userId = await this.ig.user.getIdByUsername(username);
                await this.ig.friendship.destroy(userId);
                return { success: true };
            } catch (e) {
                return { success: false, message: e.message };
            }
        }
        try {
            await this.page.goto(`https://www.instagram.com/${username}/`, {
                waitUntil: 'domcontentloaded', timeout: 30000
            });
            await sleep(2000);
            const result = await this.page.evaluate(() => {
                const btn = Array.from(document.querySelectorAll('button'))
                    .find(b => ['Following', 'Abonné(e)'].includes(b.textContent.trim()));
                if (btn) { btn.click(); return { found: true }; }
                return { found: false };
            });
            if (!result.found) return { success: false, message: 'Bouton Following introuvable.' };
            // Confirmer le unfollow dans la popup
            await sleep(1500);
            await this.page.evaluate(() => {
                const confirmBtn = Array.from(document.querySelectorAll('button'))
                    .find(b => ['Unfollow', 'Se désabonner'].includes(b.textContent.trim()));
                if (confirmBtn) confirmBtn.click();
            });
            await sleep(1000);
            return { success: true };
        } catch (e) {
            return { success: false, message: e.message };
        }
    }

    async checkFollowBack(username) {
        try {
            const userId = await this.ig.user.getIdByUsername(username);
            const friendship = await this.ig.friendship.show(userId);
            return friendship.followed_by;
        } catch (e) {
            return false;
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════════
// WORKER INSTAGRAM
// ════════════════════════════════════════════════════════════════════════════════
async function startInstagramWorker(uid, config) {
    isIgWorking = true;
    lastKnownUid = uid;
    lastIgConfig = config;
    startCaffeinate();
    io.emit('ig_status', { state: 'WORKING', desc: 'En cours...' });

    const cutoff = Date.now() - 48 * 60 * 60 * 1000;

    try {
        // Phase 1 : vérifier les follows en attente
        const pending = await getAllPendingFollows(uid);
        if (pending.length > 0) {
            io.emit('log_ig', { msg: `Vérification de ${pending.length} abonnement(s) en attente...`, type: 'info' });
            for (const action of pending) {
                if (forceStopIg) break;
                const followsBack = await igClient.checkFollowBack(action.targetUsername);
                const expired = action.timestamp <= cutoff;

                if (followsBack && config.unfollowFollowing) {
                    const r = await igClient.unfollowUser(action.targetUsername);
                    if (r.success) {
                        io.emit('log_ig', { msg: `@${action.targetUsername} nous suit → désabonné`, type: 'success' });
                        await markAsUnfollowed(action.id);
                    }
                    await sleep(5000 + Math.random() * 5000);
                } else if (!followsBack && expired && config.unfollowNotFollowing) {
                    const r = await igClient.unfollowUser(action.targetUsername);
                    if (r.success) {
                        io.emit('log_ig', { msg: `@${action.targetUsername} pas de retour (48h) → désabonné`, type: 'info' });
                        await markAsUnfollowed(action.id);
                    }
                    await sleep(5000 + Math.random() * 5000);
                } else if (expired || (followsBack && !config.unfollowFollowing)) {
                    await markAsUnfollowed(action.id);
                }
            }
        }

        // Phase 2 : nouveaux follows (via navigateur web)
        if (config.autoFollow && !forceStopIg) {
            const targets = config.scrapedUsers || [];
            if (targets.length === 0) {
                io.emit('log_ig', { msg: 'Aucune cible. Scrapez un compte d\'abord.', type: 'warn' });
            } else {
                // Lancer le navigateur une seule fois pour toute la session de follows
                await igClient.launchBrowser();
                const loggedIn = await igClient.ensureWebLoggedIn();

                if (!loggedIn) {
                    io.emit('log_ig', { msg: 'Impossible de se connecter au web Instagram.', type: 'error' });
                } else {
                    io.emit('log_ig', { msg: `Début des abonnements (${targets.length} cibles)`, type: 'info' });
                    for (const target of targets) {
                        if (forceStopIg) break;
                        const r = await igClient.followUser(target);
                        if (r.success && !r.already) {
                            io.emit('log_ig', { msg: `Abonné à @${target}`, type: 'success' });
                            await saveIgAction(uid, target);
                            const delay = Math.floor(Math.random() * (config.delayMax - config.delayMin + 1)) + config.delayMin;
                            io.emit('log_ig', { msg: `Pause anti-ban de ${delay}s...`, type: 'system' });
                            await sleep(delay * 1000);
                        } else if (r.success && r.already) {
                            io.emit('log_ig', { msg: `Déjà abonné à @${target}`, type: 'info' });
                        } else {
                            io.emit('log_ig', { msg: `Saut de @${target} : ${r.message}`, type: 'warn' });
                        }
                    }
                }

                await igClient.closeBrowser();
            }
        }

        io.emit('log_ig', { msg: 'Session Instagram terminée.', type: 'success' });
    } catch (e) {
        io.emit('log_ig', { msg: `Erreur : ${e.message}`, type: 'error' });
        await igClient.closeBrowser().catch(() => {});
    }

    stopCaffeinate();
    isIgWorking = false;
    io.emit('ig_status', { state: 'CONNECTED', desc: 'Connecté', username: igClient?.username });
}

// ── Cron : vérification automatique des désabonnements toutes les 2h ─────────
async function runAutoUnfollow() {
    if (isIgWorking || !igClient?.isConnected || !lastKnownUid || !lastIgConfig) return;
    const pending = await getAllPendingFollows(lastKnownUid).catch(() => []);
    if (pending.length === 0) return;

    console.log(`[CRON] Auto-unfollow : ${pending.length} abonnements à vérifier`);
    isIgWorking = true;
    startCaffeinate();
    io.emit('ig_status', { state: 'WORKING', desc: 'Vérif. auto désabonnements...' });
    io.emit('log_ig', { msg: `[auto] Vérification de ${pending.length} abonnement(s)...`, type: 'system' });

    try {
        await igClient.launchBrowser();
        const loggedIn = await igClient.ensureWebLoggedIn();
        if (loggedIn) {
            const cutoff = Date.now() - 48 * 60 * 60 * 1000;
            for (const action of pending) {
                if (forceStopIg) break;
                const followsBack = await igClient.checkFollowBack(action.targetUsername);
                const expired = action.timestamp <= cutoff;

                if (followsBack && lastIgConfig.unfollowFollowing) {
                    const r = await igClient.unfollowUser(action.targetUsername);
                    if (r.success) {
                        io.emit('log_ig', { msg: `[auto] @${action.targetUsername} suit → désabonné`, type: 'info' });
                        await markAsUnfollowed(action.id);
                        await sleep(12000 + Math.random() * 8000);
                    }
                } else if (!followsBack && expired && lastIgConfig.unfollowNotFollowing) {
                    const r = await igClient.unfollowUser(action.targetUsername);
                    if (r.success) {
                        io.emit('log_ig', { msg: `[auto] @${action.targetUsername} pas de retour (48h) → désabonné`, type: 'info' });
                        await markAsUnfollowed(action.id);
                        await sleep(12000 + Math.random() * 8000);
                    }
                } else if (expired || (followsBack && !lastIgConfig.unfollowFollowing)) {
                    await markAsUnfollowed(action.id);
                }
            }
        }
        await igClient.closeBrowser();
        io.emit('log_ig', { msg: '[auto] Vérification terminée.', type: 'success' });
    } catch (e) {
        console.error('[CRON] Erreur auto-unfollow:', e.message);
        await igClient.closeBrowser().catch(() => {});
    }

    stopCaffeinate();
    isIgWorking = false;
    io.emit('ig_status', { state: 'CONNECTED', desc: 'Connecté', username: igClient?.username });
}

// Toutes les 2h (évite les conflits avec une campagne manuelle)
cron.schedule('0 */2 * * *', runAutoUnfollow);

// ════════════════════════════════════════════════════════════════════════════════
// WEBSOCKETS
// ════════════════════════════════════════════════════════════════════════════════
io.on('connection', (socket) => {
    console.log('[WS] Client connecté');

    // ── Sync état WhatsApp ──
    if (wpReady) {
        socket.emit('status', { state: 'CONNECTED', desc: 'WhatsApp Connecté' });
        socket.emit('groups', globalGroups);
    } else if (wpClient) {
        socket.emit('status', { state: 'DISCONNECTED', desc: 'Connexion WhatsApp en cours...' });
    } else {
        socket.emit('status', { state: 'DISCONNECTED', desc: 'Démarrage du moteur...' });
    }

    // ── WhatsApp ──────────────────────────────────────────────────────────────

    socket.on('get_campaigns', async (data) => {
        const uid = await getUidFromToken(data);
        if (!uid) return;
        socket.emit('campaigns_list', await getCampaigns(uid));
    });

    socket.on('start_campaign', async (config) => {
        const uid = await getUidFromToken(config);
        if (!uid || !wpReady || isBotWorking) return;
        forceStop = false;
        startCampaignWorker(uid, config, socket);
    });

    socket.on('stop_campaign', async (data) => {
        const uid = await getUidFromToken(data);
        if (!uid || !isBotWorking) return;
        forceStop = true;
        socket.emit('log', { msg: 'Arrêt forcé demandé.', type: 'warn' });
    });

    socket.on('get_group_participants', async (data) => {
        const uid = await getUidFromToken(data);
        if (!uid || !wpReady) return;
        const groupId = data.groupId;
        try {
            const chat = await wpClient.getChatById(groupId);
            if (!chat.isGroup) return;
            const participants = [];
            for (const p of chat.participants) {
                const contact = await wpClient.getContactById(p.id._serialized);
                participants.push({
                    id: p.id._serialized,
                    number: contact.number || p.id.user,
                    name: contact.pushname || contact.name || contact.shortName || p.id.user,
                    isAdmin: p.isAdmin || p.isSuperAdmin
                });
            }
            const dejaFait = await getHistory(uid, groupId);
            socket.emit('group_participants', { groupId, participants, dejaFait });
        } catch (e) {
            socket.emit('log', { msg: `Erreur membres : ${e.message}`, type: 'error' });
        }
    });

    socket.on('save_campaign', async (data) => {
        const uid = await getUidFromToken(data);
        if (!uid) return;
        const id = await saveCampaign(uid, data);
        socket.emit('campaign_saved', id);
        socket.emit('campaigns_list', await getCampaigns(uid));
    });

    socket.on('delete_campaign', async (data) => {
        const uid = await getUidFromToken(data);
        if (!uid) return;
        await db.collection('campaigns').doc(data.id).delete();
        socket.emit('campaigns_list', await getCampaigns(uid));
    });

    socket.on('logout', async (data) => {
        const uid = await getUidFromToken(data);
        if (!uid || !wpClient) return;
        try { await wpClient.logout(); await wpClient.destroy(); } catch (_) {}
        wpClient = null;
        wpReady = false;
        const authDir = path.join(__dirname, '.wwebjs_auth');
        if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
        socket.emit('log', { msg: 'Déconnecté. Redémarrage du moteur...', type: 'warn' });
        initWhatsAppSession();
    });

    // ── Instagram ─────────────────────────────────────────────────────────────

    socket.on('ig_init', async () => {
        if (!igClient) {
            igClient = new InstagramClient();
            await igClient.init();
        } else {
            await igClient.checkStatus();
        }
    });

    socket.on('ig_login', async (data) => {
        if (!igClient) igClient = new InstagramClient();
        const result = await igClient.login(data.username, data.password);
        socket.emit('ig_login_result', result);
    });

    socket.on('ig_submit_code', async (data) => {
        if (!igClient) return;
        socket.emit('ig_submit_code_result', await igClient.submitCode(data.code));
    });

    socket.on('ig_logout', async () => {
        if (!igClient) return;
        await igClient.logout();
        igClient = null;
    });

    socket.on('ig_scrape_followers', async (data) => {
        if (!igClient?.isConnected) return;
        await igClient.scrapeFollowers(data.target, data.count || 200);
    });

    socket.on('ig_start_campaign', async (config) => {
        const uid = await getUidFromToken(config);
        if (!uid || !igClient?.isConnected || isIgWorking) return;
        forceStopIg = false;
        startInstagramWorker(uid, config);
    });

    socket.on('ig_stop_campaign', () => {
        if (isIgWorking) {
            forceStopIg = true;
            io.emit('log_ig', { msg: 'Arrêt forcé demandé.', type: 'warn' });
        }
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// WHATSAPP INIT
// ════════════════════════════════════════════════════════════════════════════════
function initWhatsAppSession() {
    clearChromeLocks();
    console.log('[WP] Démarrage du moteur WhatsApp...');

    wpClient = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            executablePath: getChromePath(),
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                   '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote',
                   '--single-process', '--disable-gpu']
        }
    });

    wpClient.on('qr', (qr) => {
        io.emit('qr', qr);
        io.emit('status', { state: 'QR', desc: 'Scan WhatsApp requis' });
    });

    wpClient.on('authenticated', () => {
        io.emit('log', { msg: 'Authentifié. Synchronisation...', type: 'success' });
    });

    wpClient.on('ready', async () => {
        wpReady = true;
        io.emit('status', { state: 'CONNECTED', desc: 'WhatsApp Connecté' });
        try {
            const chats = await wpClient.getChats();
            globalGroups = chats.filter(c => c.isGroup).map(g => ({ name: g.name, id: g.id._serialized }));
            io.emit('groups', globalGroups);
        } catch (e) { console.error('[WP] Erreur chats:', e.message); }
    });

    wpClient.on('disconnected', (reason) => {
        wpReady = false;
        wpClient = null;
        io.emit('status', { state: 'DISCONNECTED', desc: 'WhatsApp déconnecté' });
        io.emit('log', { msg: `Déconnecté (${reason}). Redémarrage dans 5s...`, type: 'error' });
        setTimeout(initWhatsAppSession, 5000);
    });

    wpClient.initialize().catch((err) => {
        console.error('[WP] Erreur initialize:', err.message);
        wpReady = false;
        if (err.message.includes('already running')) {
            console.log('[WP] Chrome en cours — nettoyage et retry dans 3s...');
            clearChromeLocks();
            wpClient = null;
            setTimeout(initWhatsAppSession, 3000);
        } else {
            io.emit('status', { state: 'DISCONNECTED', desc: 'Erreur WhatsApp — rechargez' });
        }
    });
}

// ════════════════════════════════════════════════════════════════════════════════
// WORKER WHATSAPP
// ════════════════════════════════════════════════════════════════════════════════
async function startCampaignWorker(uid, config, socket) {
    const heure = new Date().getHours();
    if (heure < config.hourStart || heure >= config.hourEnd) {
        io.emit('log', { msg: `Hors plage horaire (${heure}h). Plage autorisée : ${config.hourStart}h-${config.hourEnd}h.`, type: 'error' });
        return;
    }

    isBotWorking = true;
    io.emit('status', { state: 'WORKING', desc: 'Envoi en cours...' });
    io.emit('log', { msg: `Campagne démarrée — groupe : ${config.groupName}`, type: 'system' });

    try {
        const chats = await wpClient.getChats();
        const groupe = chats.find(c => c.isGroup && c.name === config.groupName);
        if (!groupe) {
            io.emit('log', { msg: 'Groupe introuvable.', type: 'error' });
            return endWorker();
        }

        const dejaFait = await getHistory(uid, groupe.id._serialized);
        const membres  = groupe.participants || [];
        const excluded = (config.excludedNumbers || '').split(',').map(n => n.trim() + '@c.us').filter(Boolean);
        const moiMeme  = wpClient.info.wid._serialized;

        let pool = membres;
        if (config.selectedMemberIds?.length) {
            pool = membres.filter(p => config.selectedMemberIds.includes(p.id._serialized));
            io.emit('log', { msg: `Ciblage manuel : ${pool.length} membres.`, type: 'info' });
        } else {
            pool = membres.filter(p => !dejaFait.includes(p.id._serialized));
        }

        const cibles = pool.filter(p => {
            const id = p.id._serialized;
            return id !== moiMeme && !excluded.some(ex => id.includes(ex));
        }).slice(0, config.batchSize);

        io.emit('stats', { total: membres.length, done: dejaFait.length, session: 0 });

        if (cibles.length === 0) {
            io.emit('log', { msg: 'Tous les membres ont déjà été contactés.', type: 'success' });
            return endWorker();
        }

        io.emit('log', { msg: `${cibles.length} membres à traiter (${config.simulationMode ? 'SIMULATION' : 'RÉEL'}).`, type: 'warn' });

        let count = 0;
        for (const membre of cibles) {
            if (forceStop) break;
            const cibleId = membre.id._serialized;
            try {
                const contact = await wpClient.getContactById(cibleId);
                const prenom  = formatNom(contact.pushname || contact.name || contact.shortName || '');
                const msg     = config.messageTemplate.replace(/{prenom}/gi, prenom);

                if (config.simulationMode) {
                    io.emit('log', { msg: `[Simulé] → ${prenom} (${cibleId.split('@')[0]}) : "${msg}"`, type: 'success' });
                } else {
                    if (config.media) {
                        const media = new MessageMedia(config.media.mimetype, config.media.data, config.media.filename);
                        await wpClient.sendMessage(cibleId, media, { caption: msg });
                    } else {
                        await wpClient.sendMessage(cibleId, msg);
                    }
                    io.emit('log', { msg: `[Envoyé] → ${prenom}`, type: 'success' });
                }

                await updateHistory(uid, groupe.id._serialized, cibleId);
                dejaFait.push(cibleId);
                count++;
                io.emit('stats', { total: membres.length, done: dejaFait.length, session: count });

                if (count < cibles.length && !forceStop) {
                    const h = new Date().getHours();
                    if (h < config.hourStart || h >= config.hourEnd) {
                        io.emit('log', { msg: `Fin de plage horaire (${h}h). Arrêt.`, type: 'warn' });
                        break;
                    }
                    const delay = Math.floor(Math.random() * (config.delayMax - config.delayMin + 1)) + config.delayMin;
                    io.emit('log', { msg: `Pause anti-ban : ${delay}s...`, type: 'system' });
                    await sleep(delay * 1000);
                }
            } catch (e) {
                io.emit('log', { msg: `Erreur envoi vers ${cibleId} : ${e.message}`, type: 'error' });
            }
        }

        io.emit('log', { msg: `Session terminée — ${count} messages traités.`, type: 'success' });
    } catch (e) {
        io.emit('log', { msg: `Erreur fatale : ${e.message}`, type: 'error' });
    }

    endWorker();
}

function endWorker() {
    isBotWorking = false;
    io.emit('status', { state: 'CONNECTED', desc: 'WhatsApp Connecté' });
}

// ════════════════════════════════════════════════════════════════════════════════
// DÉMARRAGE
// ════════════════════════════════════════════════════════════════════════════════
server.listen(PORT, () => {
    console.log('=========================================');
    console.log('  GÉDÉON — Automatisation WhatsApp');
    console.log(`  http://localhost:${PORT}`);
    console.log('=========================================');
    initWhatsAppSession(); // Appelé UNE SEULE FOIS au démarrage
});
