const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const { executablePath } = require('puppeteer-core');
require('dotenv').config();
const firebase = require('firebase/compat/app');
require('firebase/compat/firestore');

// Configuration Firebase
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
    .then(() => console.log('[FIREBASE] Connexion Firestore établie et active.'))
    .catch(err => console.error('[FIREBASE] Erreur de connexion Firestore:', err.message));

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 1e7,
    cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;

async function getUidFromToken(data) {
    if (!data) return null;
    let uid = null;
    if (typeof data === 'string') {
        uid = data;
    } else if (data.uid) {
        uid = data.uid;
    }
    if (!uid || uid === 'anonymous') {
        console.warn(`[API] Attention, UID invalide ou anonyme reçu:`, data);
        return null;
    }
    return uid;
}

// Variables globales WhatsApp
let wpClient = null;
let isBotWorking = false;
let globalGroups = [];
let forceStop = false;

// Variables globales Instagram
let igClient = null;
let isIgWorking = false;
let forceStopIg = false;

app.use(express.static(path.join(__dirname, 'public')));

// Helpers Firestore
async function getCampaigns(uid) {
    if (!db) return [];
    const snapshot = await db.collection('campaigns').where('userId', '==', uid).get();
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

async function saveCampaign(uid, data) {
    if (!db) return;
    const { idToken, uid: clientUid, ...campaignData } = data;
    campaignData.userId = uid;
    campaignData.updatedAt = Date.now();
    if (data.id) {
        const id = data.id;
        await db.collection('campaigns').doc(id).set(campaignData, { merge: true });
        return id;
    } else {
        const docRef = await db.collection('campaigns').add(campaignData);
        return docRef.id;
    }
}

async function getHistory(uid, groupId) {
    if (!db) return [];
    const doc = await db.collection('history').doc(`${uid}_${groupId}`).get();
    return doc.exists ? doc.data().participants : [];
}

async function updateHistory(uid, groupId, participantId) {
    if (!db) return;
    const docRef = db.collection('history').doc(`${uid}_${groupId}`);
    await docRef.set({
        userId: uid,
        groupId: groupId,
        participants: firebase.firestore.FieldValue.arrayUnion(participantId),
        lastUpdate: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
}

async function saveIgAction(uid, targetUsername, actionType) {
    if (!db) return;
    await db.collection('instagram_actions').add({
        userId: uid,
        targetUsername: targetUsername,
        action: actionType,
        timestamp: Date.now(),
        unfollowed: false
    });
}

async function getPendingUnfollows(uid) {
    if (!db) return [];
    const fortyEightHoursAgo = Date.now() - (48 * 60 * 60 * 1000);
    const snapshot = await db.collection('instagram_actions')
        .where('userId', '==', uid)
        .where('action', '==', 'FOLLOW')
        .where('unfollowed', '==', false)
        .where('timestamp', '<=', fortyEightHoursAgo)
        .get();
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

async function markAsUnfollowed(docId) {
    if (!db) return;
    await db.collection('instagram_actions').doc(docId).update({ unfollowed: true });
}

function formatNom(nom) {
    if (!nom) return "l'ami(e)";
    return (nom.split(' ')[0] || nom).trim();
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const randomSleep = (min, max) => sleep(Math.floor(Math.random() * (max - min + 1) + min) * 1000);

const getChromePath = () => {
    if (process.platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (process.platform === 'win32') {
        const paths = [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe'
        ];
        for (const p of paths) {
            if (fs.existsSync(p)) return p;
        }
    }
    return undefined;
};

// ============================================================
// CLASSE INSTAGRAM CLIENT (via API Mobile Instagram)
// ============================================================
const { IgApiClient } = require('instagram-private-api');

class InstagramClient {
    constructor(io) {
        this.io = io;
        this.ig = new IgApiClient();
        this.isConnected = false;
        this.username = null;
        this.sessionPath = path.join(__dirname, '.ig_session.json');
    }

    log(msg, type = 'info') {
        this.io.emit('log_ig', { msg, type });
        console.log(`[IG] ${msg}`);
    }

    // Sauvegarde la session pour ne pas se reconnecter à chaque redémarrage
    async saveSession() {
        try {
            const state = await this.ig.state.serialize();
            delete state.constants; // Pas besoin de sauvegarder les constantes
            fs.writeFileSync(this.sessionPath, JSON.stringify(state));
            this.log('Session sauvegardée.');
        } catch (e) {
            this.log('Impossible de sauvegarder la session: ' + e.message, 'warn');
        }
    }

    // Charge une session existante
    async loadSession() {
        try {
            if (fs.existsSync(this.sessionPath)) {
                const state = JSON.parse(fs.readFileSync(this.sessionPath, 'utf8'));
                await this.ig.state.deserialize(state);
                return true;
            }
        } catch (e) {
            this.log('Session précédente invalide, nouvelle connexion requise.', 'warn');
        }
        return false;
    }

    // Initialisation : tente de charger la session existante
    async init() {
        this.log('Vérification de la session Instagram...');
        const hasSession = await this.loadSession();

        if (hasSession) {
            try {
                // Vérifier que la session est encore valide
                const userInfo = await this.ig.account.currentUser();
                this.username = userInfo.username;
                this.isConnected = true;
                this.log(`Session restaurée ! Connecté en tant que @${this.username}`, 'success');
                this.io.emit('ig_status', {
                    state: 'CONNECTED',
                    desc: '🟢 Instagram Connecté',
                    username: this.username
                });
                return;
            } catch (e) {
                this.log('Session expirée, reconnexion nécessaire.', 'warn');
                this.isConnected = false;
            }
        }

        this.io.emit('ig_status', { state: 'DISCONNECTED', desc: '🔴 Instagram Déconnecté' });
    }

    // Connexion avec identifiants
    async login(username, password) {
        try {
            this.log(`Connexion en tant que @${username}...`);

            // Simuler un appareil Android pour l'API
            this.ig.state.generateDevice(username);

            // Simulation du flux de démarrage d'application (requis par Instagram)
            await this.ig.simulate.preLoginFlow();

            // Connexion
            const loggedUser = await this.ig.account.login(username, password);
            this.username = loggedUser.username;
            this.isConnected = true;

            // Finalisation du flux post-login
            process.nextTick(async () => {
                try {
                    await this.ig.simulate.postLoginFlow();
                } catch (e) {
                    this.log('Erreur post-login simulation: ' + e.message, 'warn');
                }
            });

            // Sauvegarder la session pour les prochains redémarrages
            await this.saveSession();

            this.log(`✅ Connecté avec succès en tant que @${this.username} !`, 'success');
            this.io.emit('ig_status', {
                state: 'CONNECTED',
                desc: '🟢 Instagram Connecté',
                username: this.username
            });

            return { success: true };

        } catch (e) {
            const msg = e.message || 'Erreur inconnue';

            // Instagram demande un challenge (2FA, téléphone, etc.)
            if (e.name === 'IgCheckpointError') {
                this.log('🛡️ Vérification de sécurité requise (checkpoint Instagram).', 'warn');
                try {
                    await this.ig.challenge.auto(true);
                    this.io.emit('ig_code_required', true);
                    return { success: true, codeRequired: true };
                } catch (challengeErr) {
                    this.log(`Erreur challenge: ${challengeErr.message}`, 'error');
                    return { success: false, message: 'Challenge requis mais impossible à résoudre automatiquement.' };
                }
            }

            // Mauvais mot de passe
            if (e.name === 'IgLoginBadPasswordError') {
                this.log('Mot de passe incorrect.', 'error');
                return { success: false, message: 'Mot de passe incorrect.' };
            }

            // Compte bloqué / rate limit
            if (e.name === 'IgLoginInvalidUserError') {
                this.log('Compte introuvable.', 'error');
                return { success: false, message: 'Nom d\'utilisateur introuvable.' };
            }

            this.log(`Erreur de connexion : ${msg}`, 'error');
            return { success: false, message: msg };
        }
    }

    // Valide le code 2FA / challenge
    async submitCode(code) {
        try {
            this.log(`Soumission du code : ${code}...`);
            await this.ig.challenge.sendSecurityCode(code);
            const loggedUser = await this.ig.account.currentUser();
            this.username = loggedUser.username;
            this.isConnected = true;
            await this.saveSession();
            this.log(`✅ Code accepté ! Connecté en tant que @${this.username}`, 'success');
            this.io.emit('ig_status', {
                state: 'CONNECTED',
                desc: '🟢 Instagram Connecté',
                username: this.username
            });
            return { success: true };
        } catch (e) {
            this.log(`Erreur code: ${e.message}`, 'error');
            return { success: false, message: e.message };
        }
    }

    // Déconnexion et nettoyage
    async logout() {
        try {
            await this.ig.account.logout();
        } catch (e) {}
        if (fs.existsSync(this.sessionPath)) {
            fs.unlinkSync(this.sessionPath);
        }
        this.isConnected = false;
        this.username = null;
        this.io.emit('ig_status', { state: 'DISCONNECTED', desc: '🔴 Instagram Déconnecté' });
        this.log('Déconnecté d\'Instagram.');
    }

    // Scrape les followers d'un compte
    async scrapeFollowers(targetUsername, count = 100) {
        try {
            this.log(`Recherche des abonnés de @${targetUsername}...`);
            const userId = await this.ig.user.getIdByUsername(targetUsername.replace('@', ''));
            const followersFeed = this.ig.feed.accountFollowers(userId);

            const results = [];
            do {
                const page = await followersFeed.items();
                results.push(...page.map(u => u.username));
                this.log(`🔍 ${results.length} abonnés récupérés...`);
                if (results.length >= count) break;
                await sleep(1500 + Math.random() * 1000); // Délai humain
            } while (followersFeed.isMoreAvailable());

            const finalList = results.slice(0, count);
            this.log(`✅ Scraping terminé : ${finalList.length} abonnés.`, 'success');
            this.io.emit('ig_scraped_data', finalList);
            return finalList;
        } catch (e) {
            this.log(`Erreur scraping : ${e.message}`, 'error');
            return [];
        }
    }

    // Follow un utilisateur
    async followUser(username) {
        try {
            const userId = await this.ig.user.getIdByUsername(username);
            await this.ig.friendship.create(userId);
            return { success: true };
        } catch (e) {
            return { success: false, message: e.message };
        }
    }

    // Unfollow un utilisateur
    async unfollowUser(username) {
        try {
            const userId = await this.ig.user.getIdByUsername(username);
            await this.ig.friendship.destroy(userId);
            return { success: true };
        } catch (e) {
            return { success: false, message: e.message };
        }
    }

    // Vérifie si un utilisateur nous suit en retour
    async checkFollowBack(username) {
        try {
            const userId = await this.ig.user.getIdByUsername(username);
            const friendship = await this.ig.friendship.show(userId);
            return friendship.followed_by; // true si il nous suit
        } catch (e) {
            return false;
        }
    }
}
// ============================================================
// WORKER INSTAGRAM
// ============================================================
async function startInstagramCampaignWorker(uid, config, io) {
    isIgWorking = true;
    io.emit('ig_status', { state: 'WORKING', desc: "✈️ Automate Instagram en cours..." });

    try {
        const pendingUnfollows = await getPendingUnfollows(uid);
        if (pendingUnfollows.length > 0) {
            io.emit('log_ig', { msg: `🧹 Nettoyage : ${pendingUnfollows.length} désabonnements en attente...`, type: 'info' });
            for (const action of pendingUnfollows) {
                if (forceStopIg) break;
                const followsBack = await igClient.checkFollowBack(action.targetUsername);
                let shouldUnfollow = false;
                if (!followsBack && config.unfollowNotFollowing) shouldUnfollow = true;
                if (followsBack && config.unfollowFollowing) shouldUnfollow = true;

                if (shouldUnfollow) {
                    const res = await igClient.unfollowUser(action.targetUsername);
                    if (res.success) {
                        io.emit('log_ig', { msg: `✅ Désabonné de ${action.targetUsername}`, type: 'success' });
                        await markAsUnfollowed(action.id);
                    }
                } else {
                    await markAsUnfollowed(action.id);
                }
                await randomSleep(config.delayMin, config.delayMax);
            }
        }

        if (config.autoFollow && !forceStopIg) {
            if (config.scrapedUsers && config.scrapedUsers.length > 0) {
                io.emit('log_ig', { msg: `🔥 Début des abonnements (${config.scrapedUsers.length} cibles)`, type: 'info' });
                for (const target of config.scrapedUsers) {
                    if (forceStopIg) break;
                    const res = await igClient.followUser(target);
                    if (res.success) {
                        io.emit('log_ig', { msg: `👤 Suivi : ${target}`, type: 'success' });
                        await saveIgAction(uid, target, 'FOLLOW');
                        const delay = Math.floor(Math.random() * (config.delayMax - config.delayMin + 1)) + config.delayMin;
                        io.emit('log_ig', { msg: `⏳ Pause de ${delay}s...`, type: 'system' });
                        await sleep(delay * 1000);
                    } else {
                        io.emit('log_ig', { msg: `⚠️ Saut de ${target}: ${res.message}`, type: 'warn' });
                    }
                }
            }
        }

        io.emit('log_ig', { msg: `🎉 Session Instagram terminée !`, type: 'success' });
    } catch (e) {
        io.emit('log_ig', { msg: `❌ Erreur Automate: ${e.message}`, type: 'error' });
    }

    isIgWorking = false;
    io.emit('ig_status', { state: 'CONNECTED', desc: "🟢 Instagram Prêt" });
}

// ============================================================
// GESTION WEBSOCKETS
// ============================================================
io.on('connection', (socket) => {
    console.log('[API] Un client est connecté au Dashboard');
    socket.emit('log', { msg: 'Connecté au serveur en arrière-plan. En attente d\'authentification cloud...', type: 'system' });

    socket.on('get_campaigns', async (data) => {
        const uid = await getUidFromToken(data);
        console.log(`[API] Requête reçue pour UID: ${uid}`);
        if (!uid || uid === 'anonymous') return;
        const list = await getCampaigns(uid);
        console.log(`[API] Envoi de ${list.length} campagnes à ${uid}`);
        socket.emit('campaigns_list', list);
    });

    if (wpClient) {
        if (isBotWorking) {
            socket.emit('status', { state: 'WORKING', desc: "🟢 Campagne en cours" });
        } else {
            socket.emit('status', { state: 'CONNECTED', desc: "🟢 WhatsApp Connecté" });
            socket.emit('groups', globalGroups);
        }
    } else {
        socket.emit('status', { state: 'DISCONNECTED', desc: "🔴 Lancement du moteur..." });
        initWhatsAppSession(socket);
    }

    socket.on('start_campaign', async (config) => {
        const uid = await getUidFromToken(config);
        if (!uid || !wpClient || isBotWorking) return;
        forceStop = false;
        await startCampaignWorker(uid, config, socket);
    });

    socket.on('stop_campaign', async (data) => {
        const uid = await getUidFromToken(data);
        if (!uid) return;
        if (isBotWorking) {
            forceStop = true;
            socket.emit('log', { msg: '⚠️ Demande d\'arrêt forcé reçue !', type: 'warn' });
        }
    });

    socket.on('get_group_participants', async (data) => {
        const uid = await getUidFromToken(data);
        if (!uid || !wpClient) return;
        const groupId = data.groupId || data;
        try {
            const chat = await wpClient.getChatById(groupId);
            if (chat.isGroup) {
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
            }
        } catch (e) {
            socket.emit('log', { msg: `Erreur récupération membres: ${e.message}`, type: 'error' });
        }
    });

    socket.on('save_campaign', async (campaignData) => {
        const uid = await getUidFromToken(campaignData);
        if (!uid) return;
        const newId = await saveCampaign(uid, campaignData);
        socket.emit('log', { msg: `✅ Campagne sauvegardée dans le cloud !`, type: 'success' });
        socket.emit('campaign_saved', newId);
        socket.emit('campaigns_list', await getCampaigns(uid));
    });

    socket.on('delete_campaign', async (data) => {
        const uid = await getUidFromToken(data);
        if (!uid || !db) return;
        try {
            await db.collection('campaigns').doc(data.id).delete();
            socket.emit('log', { msg: '🗑️ Campagne supprimée du cloud.', type: 'info' });
            socket.emit('campaigns_list', await getCampaigns(uid));
        } catch (e) {
            socket.emit('log', { msg: 'Erreur suppression: ' + e.message, type: 'error' });
        }
    });

    socket.on('logout', async (data) => {
        const uid = await getUidFromToken(data);
        if (!uid || !wpClient) return;
        socket.emit('log', { msg: '🔔 Déconnexion en cours...', type: 'warn' });
        try {
            await wpClient.logout();
            await wpClient.destroy();
        } catch (e) {
            console.error("Erreur lors du logout:", e);
        }
        wpClient = null;
        isBotWorking = false;
        const sessionPath = path.join(__dirname, '.wwebjs_auth');
        if (fs.existsSync(sessionPath)) {
            try {
                fs.rmSync(sessionPath, { recursive: true, force: true });
                socket.emit('log', { msg: '✅ Session supprimée. Prêt pour un nouveau Scan.', type: 'success' });
            } catch (err) {
                console.error("Erreur suppression session:", err);
            }
        }
        initWhatsAppSession(socket);
    });

    // ---- Handlers Instagram ----

    socket.on('ig_init', async () => {
        if (!igClient) {
            igClient = new InstagramClient(io);
            socket.emit('ig_status', { state: 'DISCONNECTED', desc: '🟠 Initialisation du moteur...' });
            await igClient.init();
        } else {
            // Client déjà en mémoire → juste rafraîchir le statut
            await igClient.checkAndUpdateStatus();
        }
    });

    socket.on('ig_force_login', async () => {
        if (igClient) await igClient.forceLoginView();
    });

    socket.on('ig_login', async (data) => {
        if (!igClient) return;
        const result = await igClient.login(data.username, data.password);
        socket.emit('ig_login_result', result);
    });

    socket.on('ig_submit_code', async (data) => {
        if (!igClient) return;
        const result = await igClient.submitCode(data.code);
        socket.emit('ig_submit_code_result', result);
    });

    socket.on('ig_logout', async () => {
        if (igClient) {
            await igClient.logout();
            igClient = null;
        }
    });

    socket.on('ig_remote_click', async (data) => {
        if (igClient) await igClient.remoteClick(data.x, data.y);
    });

    socket.on('ig_remote_type', async (data) => {
        if (igClient) await igClient.remoteType(data.text);
    });

    socket.on('ig_remote_key', async (data) => {
        if (igClient) await igClient.remoteKey(data.key);
    });

    socket.on('ig_scrape_followers', async (data) => {
        if (!igClient || !igClient.isConnected) return;
        await igClient.scrapeFollowers(data.target, 50);
    });

    socket.on('ig_start_campaign', async (config) => {
        const uid = await getUidFromToken(config);
        if (!uid || !igClient || !igClient.isConnected || isIgWorking) return;
        forceStopIg = false;
        io.emit('log_ig', { msg: '🚀 Démarrage de la campagne Instagram...', type: 'info' });
        await startInstagramCampaignWorker(uid, config, io);
    });

    socket.on('ig_stop_campaign', () => {
        if (isIgWorking) {
            forceStopIg = true;
            io.emit('log_ig', { msg: '⚠️ Arrêt forcé demandé...', type: 'warn' });
        }
    });
});

// ============================================================
// INITIALISATION WHATSAPP
// ============================================================
function initWhatsAppSession(initialSocket = null) {
    console.log('[WHATSAPP] Démarrage de l\'instance Moteur...');
    if (initialSocket) initialSocket.emit('log', { msg: 'Lancement du navigateur interne...', type: 'system' });

    wpClient = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            executablePath: getChromePath(),
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-gpu'
            ],
            headless: true
        }
    });

    wpClient.on('qr', (qr) => {
        console.log('[WHATSAPP] QR Code reçu. Renvoi vers le Web.');
        io.emit('qr', qr);
        io.emit('status', { state: 'QR', desc: '⚠️ Attente Scan WhatsApp' });
        io.emit('log', { msg: 'Un nouveau code a été généré.', type: 'info' });
    });

    wpClient.on('authenticated', () => {
        console.log('[WHATSAPP] Authentification OK');
        io.emit('log', { msg: 'Authentification réussie ! Synchronisation des groupes...', type: 'success' });
    });

    wpClient.on('ready', async () => {
        console.log('[WHATSAPP] Prêt et synchronisé.');
        io.emit('status', { state: 'CONNECTED', desc: '🟢 WhatsApp Prêt' });
        try {
            const chats = await wpClient.getChats();
            const grps = chats.filter(chat => chat.isGroup);
            globalGroups = grps.map(g => ({ name: g.name, id: g.id._serialized }));
            io.emit('groups', globalGroups);
        } catch (e) {
            console.error("Erreur lecture chats:", e);
        }
    });

    wpClient.on('disconnected', (reason) => {
        io.emit('log', { msg: `WhatsApp déconnecté: ${reason}. Rechargement nécessaire.`, type: 'error' });
        io.emit('status', { state: 'DISCONNECTED', desc: '🔴 Déconnecté' });
        wpClient.destroy();
        wpClient = null;
    });

    wpClient.initialize();
}

// ============================================================
// MOTEUR D'ENVOI WHATSAPP
// ============================================================
async function startCampaignWorker(uid, config, socket) {
    const currentHour = new Date().getHours();
    if (currentHour < config.hourStart || currentHour >= config.hourEnd) {
        io.emit('log', { msg: `🛑 HORS PLAGE HORAIRE : Il est ${currentHour}h. La plage autorisée est ${config.hourStart}h-${config.hourEnd}h.`, type: 'error' });
        return endWorker();
    }

    isBotWorking = true;
    io.emit('status', { state: 'WORKING', desc: "✈️ Envoi Automatique..." });
    io.emit('log', { msg: `🔥 CAMPAGNE DÉMARRÉE (Groupe: ${config.groupName})`, type: 'system' });

    try {
        const chats = await wpClient.getChats();
        const groupeCible = chats.find(c => c.isGroup && c.name === config.groupName);

        if (!groupeCible) {
            io.emit('log', { msg: 'Erreur: Impossible de trouver le groupe sélectionné.', type: 'error' });
            return endWorker();
        }

        const dejaFait = await getHistory(uid, groupeCible.id._serialized);
        const membresDuGroupe = groupeCible.participants || [];
        const excludedList = config.excludedNumbers ? config.excludedNumbers.split(',').map(n => n.trim() + '@c.us') : [];
        const moi_meme = wpClient.info.wid._serialized;

        io.emit('log', { msg: `Analyse du groupe : ${membresDuGroupe.length} membres total.`, type: 'info' });

        let poolDeMembres = membresDuGroupe;
        if (config.selectedMemberIds) {
            poolDeMembres = membresDuGroupe.filter(p => config.selectedMemberIds.includes(p.id._serialized));
            io.emit('log', { msg: `Ciblage manuel : ${poolDeMembres.length} membres sélectionnés.`, type: 'info' });
        } else {
            poolDeMembres = membresDuGroupe.filter(p => !dejaFait.includes(p.id._serialized));
        }

        let membresRestants = poolDeMembres.filter(participant => {
            const pId = participant.id._serialized;
            if (pId === moi_meme) return false;
            if (excludedList.some(ex => pId.includes(ex))) return false;
            return true;
        });

        io.emit('stats', { total: membresDuGroupe.length, done: dejaFait.length, session: 0 });

        if (membresRestants.length === 0) {
            io.emit('log', { msg: `Terminé ! Tous les membres ont déjà été contactés.`, type: 'success' });
            return endWorker();
        }

        const aEnvoyerList = membresRestants.slice(0, config.batchSize);
        io.emit('log', { msg: `Cible pour cette session : ${aEnvoyerList.length} membres (${config.simulationMode ? 'SIMULATION' : 'RÉEL'}).`, type: 'warn' });

        let sessionCount = 0;

        for (const membre of aEnvoyerList) {
            if (forceStop) break;

            const cibleId = membre.id._serialized;
            try {
                const contactInfo = await wpClient.getContactById(cibleId);
                let nomBrut = contactInfo.pushname || contactInfo.name || contactInfo.shortName || '';
                let prenomFormatte = formatNom(nomBrut);
                const msgFinal = config.messageTemplate.replace(/{prenom}/gi, prenomFormatte);

                if (config.simulationMode) {
                    io.emit('log', { msg: `[Simulé] ${prenomFormatte} (${cibleId.split('@')[0]}) => "${msgFinal}" ${config.media ? '(+ Média)' : ''}`, type: 'success' });
                } else {
                    try {
                        if (config.media) {
                            const media = new MessageMedia(config.media.mimetype, config.media.data, config.media.filename);
                            await wpClient.sendMessage(cibleId, media, { caption: msgFinal });
                            io.emit('log', { msg: `[Envoyé] Média + Message remis à ${prenomFormatte}.`, type: 'success' });
                        } else {
                            await wpClient.sendMessage(cibleId, msgFinal);
                            io.emit('log', { msg: `[Envoyé] Message remis à ${prenomFormatte}.`, type: 'success' });
                        }
                    } catch (sendErr) {
                        io.emit('log', { msg: `❌ Erreur d'envoi vers ${prenomFormatte} : ${sendErr.message}`, type: 'error' });
                        continue;
                    }
                }

                dejaFait.push(cibleId);
                await updateHistory(uid, groupeCible.id._serialized, cibleId);
                sessionCount++;
                io.emit('stats', { total: membresDuGroupe.length, done: dejaFait.length, session: sessionCount });

                if (sessionCount < aEnvoyerList.length && !forceStop) {
                    const nowHour = new Date().getHours();
                    if (nowHour < config.hourStart || nowHour >= config.hourEnd) {
                        io.emit('log', { msg: `🛑 FIN DE PLAGE HORAIRE : Il est ${nowHour}h. Arrêt de la campagne.`, type: 'warn' });
                        break;
                    }
                    const delaySeconds = Math.floor(Math.random() * (config.delayMax - config.delayMin + 1)) + config.delayMin;
                    io.emit('log', { msg: `⏳ Anti-Ban : Pause de ${delaySeconds} sec avant le prochain...`, type: 'system' });
                    await sleep(delaySeconds * 1000);
                }

            } catch (err) {
                io.emit('log', { msg: `❌ Echec d'envoi vers ${cibleId} : ${err.message}`, type: 'error' });
            }
        }

        io.emit('log', { msg: `🎉 FIN DE SESSION. ${sessionCount} messages ont été traités !`, type: 'success' });

    } catch (err) {
        io.emit('log', { msg: `CRASH FATAL : ${err.message}`, type: 'error' });
    }

    endWorker();
}

function endWorker() {
    isBotWorking = false;
    io.emit('status', { state: 'CONNECTED', desc: "🟢 Prêt et En attente" });
}

// ============================================================
// DÉMARRAGE DU SERVEUR
// ============================================================
server.listen(PORT, () => {
    console.log(`=========================================`);
    console.log(`🤖 GÉDÉON : AUTOMATISATION WHATSAPP`);
    console.log(`🌐 Accédez depuis Chrome : http://localhost:${PORT}`);
    console.log(`=========================================`);
});
