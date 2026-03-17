const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const firebase = require('firebase/compat/app');
require('firebase/compat/firestore');

// Configuration Firebase (Utilise tes clés déjà fournies)
const firebaseConfig = {
  apiKey: "AIzaSyBNkbLMeK5sTDXW8-NvMdZ-5VZTL_a0X6o",
  authDomain: "gedeon-larbin.firebaseapp.com",
  projectId: "gedeon-larbin",
  storageBucket: "gedeon-larbin.firebasestorage.app",
  messagingSenderId: "750672153668",
  appId: "1:750672153668:web:1537bebe32799e71590011"
};

// Initialisation simplifiée (sans fichier JSON !)
const app_firebase = firebase.apps.length ? firebase.app() : firebase.initializeApp(firebaseConfig);
const db = app_firebase.firestore();

// Test de connexion immédiat
db.collection('test').limit(1).get()
    .then(() => console.log('[FIREBASE] Connexion Firestore établie et active.'))
    .catch(err => console.error('[FIREBASE] Erreur de connexion Firestore:', err.message));

// Configuration du Serveur
const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    maxHttpBufferSize: 1e7, // 10 Mo pour les photos/vidéos
    cors: { origin: "*" } 
});

const PORT = process.env.PORT || 3000;

async function getUidFromToken(data) {
    if (!data) return null;
    let uid = null;
    
    // Si la data est directement un string, on suppose que c'est l'uid
    if (typeof data === 'string') {
        uid = data;
    } else if (data.uid) {
        // Le client passe maintenant toujours l'uid dans data.uid
        uid = data.uid;
    }

    if (!uid || uid === 'anonymous') {
        console.warn(`[API] Attention, UID invalide ou anonyme reçu:`, data);
        return null;
    }

    return uid;
}

// Variables Globale WhatsApp Session
let wpClient = null;
let isBotWorking = false;
let globalGroups = [];
let forceStop = false;

// Middleware pour servir le dashboard
app.use(express.static(path.join(__dirname, 'public')));

// Helpers Cloud Firestore (Remplacent les helpers BDD locaux)
async function getCampaigns(uid) {
    if (!db) return [];
    const snapshot = await db.collection('campaigns').where('userId', '==', uid).get();
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

async function saveCampaign(uid, data) {
    if (!db) return;
    const { idToken, uid: clientUid, ...campaignData } = data; 
    campaignData.userId = uid;
    // Note: On utilise Date.now() car l'objet FieldValue diffère entre client/admin
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

function formatNom(nom) {
    if (!nom) return "l'ami(e)";
    return (nom.split(' ')[0] || nom).trim();
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const randomSleep = (min, max) => sleep(Math.floor(Math.random() * (max - min + 1) + min) * 1000);

// Gestion WebSockets
io.on('connection', (socket) => {
    console.log('[API] Un client est connecté au Dashboard');

    socket.emit('log', { msg: 'Connecté au serveur en arrière-plan. En attente d\'authentification cloud...', type: 'system' });
    
    // On n'envoie plus la liste au démarrage, on attend que le client envoie son token
    socket.on('get_campaigns', async (data) => {
        const uid = await getUidFromToken(data);
        console.log(`[API] Requête reçue pour UID: ${uid}`);
        if (!uid || uid === 'anonymous') return;
        const list = await getCampaigns(uid);
        console.log(`[API] Envoi de ${list.length} campagnes à ${uid}`);
        socket.emit('campaigns_list', list);
    });

    // Selon l'état actuel de WhatsApp, on prévient le dashboard
    if (wpClient) {
        if (isBotWorking) {
            socket.emit('status', { state: 'WORKING', desc: "🟢 Campagne en cours" });
        } else {
            // Si le client est prêt mais ne travaille pas
            socket.emit('status', { state: 'CONNECTED', desc: "🟢 WhatsApp Connecté" });
            socket.emit('groups', globalGroups);
        }
    } else {
        socket.emit('status', { state: 'DISCONNECTED', desc: "🔴 Lancement du moteur..." });
        initWhatsAppSession(socket);
    }

    // L'utilisateur clique sur "Lancer la session"
    socket.on('start_campaign', async (config) => {
        const uid = await getUidFromToken(config);
        if (!uid || !wpClient || isBotWorking) return;
        
        forceStop = false;
        await startCampaignWorker(uid, config, socket);
    });

    // Arrêt Forcé
    socket.on('stop_campaign', async (data) => {
        const uid = await getUidFromToken(data);
        if (!uid) return;

        if (isBotWorking) {
            forceStop = true;
            socket.emit('log', { msg: '⚠️ Demande d\'arrêt forcé reçue !', type: 'warn' });
        }
    });

    // Demander la liste des participants d'un groupe spécifique
    socket.on('get_group_participants', async (data) => {
        const uid = await getUidFromToken(data);
        if (!uid || !wpClient) return;

        const groupId = data.groupId || data; // Fallback pour compatibilité
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

    // Gestion des Campagnes (Sauvegarder)
    socket.on('save_campaign', async (campaignData) => {
        const uid = await getUidFromToken(campaignData);
        if (!uid) return;

        const newId = await saveCampaign(uid, campaignData);
        socket.emit('log', { msg: `✅ Campagne sauvegardée dans le cloud !`, type: 'success' });
        
        socket.emit('campaign_saved', newId);
        socket.emit('campaigns_list', await getCampaigns(uid));
    });

    // Supprimer une campagne
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

    // Déconnexion complète pour changer de compte
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

        // Supprimer le dossier de session pour forcer un nouveau QR Code
        const sessionPath = path.join(__dirname, '.wwebjs_auth');
        if (fs.existsSync(sessionPath)) {
            try {
                fs.rmSync(sessionPath, { recursive: true, force: true });
                socket.emit('log', { msg: '✅ Session supprimée. Prêt pour un nouveau Scan.', type: 'success' });
            } catch (err) {
                console.error("Erreur suppression session:", err);
            }
        }

        // Relancer une session vierge
        initWhatsAppSession(socket);
    });
});

// Initialisation de WhatsApp (Une seule fois par démarrage de l'appli)
function initWhatsAppSession(initialSocket=null) {
    console.log('[WHATSAPP] Démarrage de l\'instance Moteur...');
    if(initialSocket) initialSocket.emit('log', { msg: 'Lancement du navigateur interne...', type: 'system' });

    const getChromePath = () => {
        if(process.platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
        if(process.platform === 'win32') {
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
            headless: true // Important: on cache pour les perfs
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
        
        // On récupère les groupes pour remplir la liste déroulante côté client Web
        try {
            const chats = await wpClient.getChats();
            const grps = chats.filter(chat => chat.isGroup);
            globalGroups = grps.map(g => ({ name: g.name, id: g.id._serialized }));
            io.emit('groups', globalGroups);
        } catch(e) {
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

// MOTEUR D'ENVOI (LE WORKER)
async function startCampaignWorker(uid, config, socket) {
    // Vérification initiale de l'heure
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

        // Si l'utilisateur a sélectionné des membres depuis l'interface, on se fie STRICTEMENT à cette liste
        let poolDeMembres = membresDuGroupe;
        if (config.selectedMemberIds) {
            poolDeMembres = membresDuGroupe.filter(p => config.selectedMemberIds.includes(p.id._serialized));
            io.emit('log', { msg: `Ciblage manuel : ${poolDeMembres.length} membres sélectionnés.`, type: 'info' });
        } else {
            // Mode fallback si la liste n'est pas fournie : on retire ceux qui sont dans dejaFait
            poolDeMembres = membresDuGroupe.filter(p => !dejaFait.includes(p.id._serialized));
        }

        let membresRestants = poolDeMembres.filter(participant => {
            const pId = participant.id._serialized;
            if (pId === moi_meme) return false;
            // Check exclusion liste noire
            if (excludedList.some(ex => pId.includes(ex))) return false;
            return true;
        });

        // Mise a jour Stats UI
        io.emit('stats', { total: membresDuGroupe.length, done: dejaFait.length, session: 0 });

        if (membresRestants.length === 0) {
            io.emit('log', { msg: `Terminé ! Tous les membres ont déjà été contactés.`, type: 'success' });
            return endWorker();
        }

        const aEnvoyerList = membresRestants.slice(0, config.batchSize);
        io.emit('log', { msg: `Cible pour cette session : ${aEnvoyerList.length} membres (${config.simulationMode ? 'SIMULATION' : 'RÉEL'}).`, type: 'warn' });

        let sessionCount = 0;

        for (const membre of aEnvoyerList) {
            if(forceStop) break; // Arrêt d'urgence depuis l'UI

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
                            // On envoie le média avec le message en légende (caption)
                            await wpClient.sendMessage(cibleId, media, { caption: msgFinal });
                            io.emit('log', { msg: `[Envoyé] Média + Message remis à ${prenomFormatte}.`, type: 'success' });
                        } else {
                            await wpClient.sendMessage(cibleId, msgFinal);
                            io.emit('log', { msg: `[Envoyé] Message remis à ${prenomFormatte}.`, type: 'success' });
                        }
                    } catch (sendErr) {
                        io.emit('log', { msg: `❌ Erreur d'envoi vers ${prenomFormatte} : ${sendErr.message}`, type: 'error' });
                        continue; // On passe au suivant même si celui-ci a échoué
                    }
                }

                // Toujours mettre a jour pour avancer le workfow
                dejaFait.push(cibleId);
                await updateHistory(uid, groupeCible.id._serialized, cibleId);
                sessionCount++;
                
                io.emit('stats', { total: membresDuGroupe.length, done: dejaFait.length, session: sessionCount });

                // Anti-Ban Pause si ce n'est pas le dernier
                if (sessionCount < aEnvoyerList.length && !forceStop) {
                    // Vérification de l'heure pendant la boucle
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

    } catch(err) {
        io.emit('log', { msg: `CRASH FATAL : ${err.message}`, type: 'error' });
    }

    endWorker();
}

function endWorker() {
    isBotWorking = false;
    io.emit('status', { state: 'CONNECTED', desc: "🟢 Prêt et En attente" });
}

// Run Server
server.listen(PORT, () => {
    console.log(`=========================================`);
    console.log(`🤖 GÉDÉON : AUTOMATISATION WHATSAPP`);
    console.log(`🌐 Accédez depuis Chrome : http://localhost:${PORT}`);
    console.log(`=========================================`);
});
