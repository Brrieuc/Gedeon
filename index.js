require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

// ==========================================
// CONFIGURATIONS ROBUSTES & SENSIBLES
// ==========================================
// Import since dotenv
const NOM_DU_GROUPE = process.env.GROUP_NAME;
const MESSAGE_TYPE = process.env.MESSAGE_TEMPLATE;
const DELAY_MIN = parseInt(process.env.DELAY_MIN_SECONDS) || 30;
const DELAY_MAX = parseInt(process.env.DELAY_MAX_SECONDS) || 90;
const SIMULATION_MODE = process.env.SIMULATION_MODE === 'true';
const EXECUTION_BATCH_SIZE = parseInt(process.env.BATCH_SIZE) || 20;

const HOUR_START = parseInt(process.env.SEND_HOUR_START) || 9;
const HOUR_END = parseInt(process.env.SEND_HOUR_END) || 19;

// Numéros exclus à parse depuis le .env (ex: "33612345678,33687654321")
const excludedList = process.env.EXCLUDED_NUMBERS ? process.env.EXCLUDED_NUMBERS.split(',').map(n => n.trim() + '@c.us') : [];

// Fichier d'état
const FICHIER_ETAT = path.join(__dirname, 'database_envois.json');

// ==========================================
// FONCTIONS UTILITAIRES DE SÉCURITÉ
// ==========================================
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const randomSleep = (min, max) => sleep(Math.floor(Math.random() * (max - min + 1) + min) * 1000);

// Vérifie si on est dans les horaires d'ouvertures (pour éviter d'envoyer à 4h mat)
function estHeureAutorisee() {
    const act = new Date().getHours();
    return act >= HOUR_START && act < HOUR_END;
}

// Initialise/Charge la BDD de l'état d'envoi
function chargerEtat() {
    if (!fs.existsSync(FICHIER_ETAT)) {
        fs.writeFileSync(FICHIER_ETAT, JSON.stringify({}, null, 2));
        return {};
    }
    try {
        return JSON.parse(fs.readFileSync(FICHIER_ETAT, 'utf-8'));
    } catch(e) {
        console.error("❌ ERREUR CRITIQUE: Impossible de lire le fichier de BDD (database_envois.json).", e.message);
        process.exit(1);
    }
}

function sauveEtat(etat) {
    fs.writeFileSync(FICHIER_ETAT, JSON.stringify(etat, null, 2));
}

// Nettoyer les caractères spéciaux ou émojis abusifs dans les noms
function formatNom(nom) {
    if (!nom) return "l'ami(e)";
    // On prend seulement la première partie (prénom) si y a des espaces
    let p = nom.split(' ')[0] || nom;
    // On peut appliquer d'autres regex ici
    return p;
}


// ==========================================
// MOTEUR PRINCIPAL WHATSAPP
// ==========================================
console.log(`
=========================================
🤖 DÉMARRAGE DU BOT WHATSAPP AUTO-SENDER
=========================================
📦 Groupe Ciblé      : "${NOM_DU_GROUPE}"
🗜️ Lot d'envoi       : ${EXECUTION_BATCH_SIZE} msg max / session
⏱️ Délai de pause    : ${DELAY_MIN}s - ${DELAY_MAX}s
⏰ Heures d'envoi    : ${HOUR_START}h00 à ${HOUR_END}h00
🛑 Mode Simulation   : ${SIMULATION_MODE ? "🟢 ACTIF (Aucun envoi réel)" : "🔴 INACTIF (ENVOI RÉEL)"}
🚫 Numéros exclus    : ${excludedList.length} numéro(s) ignoré(s)
=========================================
`);

// Initialisation intelligente avec le Chrome de l'utilisateur (Mac)
const getChromePath = () => {
    // Si Windows/Linux on le laisse trouver lui même. Sur Mac on force:
    if(process.platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    return undefined; // Puppeteer-core se débrouillera avec un path injecté... On suppose qu'on est sur Mac.
};

const client = new Client({
    authStrategy: new LocalAuth(), // LocalAuth conserve le cookie de session (pas besoin de rescanner)
    puppeteer: {
        executablePath: getChromePath(),
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', // très important pr la stabilité serveur
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process', // <- Peut faire crasher sur Windows mais bien pr Mac
            '--disable-gpu'
        ],
    }
});

// Authentication
client.on('qr', (qr) => {
    console.log('\n📱 NOUVELLE CONNEXION REQUISE');
    console.log('Veuillez scanner ce QR Code avec l\'application WhatsApp de votre téléphone (Appareils Connectés):\n');
    qrcode.generate(qr, {small: true});
});

client.on('authenticated', () => console.log('✅ Authentification réussie ! Sauvegarde de la session en cours...'));
client.on('ready', async () => {
    console.log('\n✅ Client Connecté et Prêt ! Connexion WhatsApp établie.\n');

    if (!estHeureAutorisee()) {
        console.log(`⚠️ HORS HORAIRES : Il est actuellement en dehors des horaires autorisés (${HOUR_START}h-${HOUR_END}h).`);
        console.log(`Le script s'arrête ici. Créez une tâche cron (ou relancez manuellement) pour l'exécuter à la bonne heure.`);
        process.exit(0);
    }
    
    try {
        console.log('🔍 Recherche des groupes...');
        const chats = await client.getChats();
        const groupes = chats.filter(chat => chat.isGroup);

        const groupeCible = groupes.find(chat => chat.name.toLowerCase() === NOM_DU_GROUPE.toLowerCase());

        if (!groupeCible) {
            console.error(`\n❌ ERREUR: Le groupe "${NOM_DU_GROUPE}" est introuvable.`);
            console.log("\n--- Groupes auxquels votre compte a accès ---");
            groupes.forEach(g => console.log(`👉 ${g.name}`));
            process.exit(1);
        }

        console.log(`\n🎯 GROUPE CIBLE SÉLECTIONNÉ : "${groupeCible.name}"`);
        
        let db = chargerEtat();
        if (!db[groupeCible.id._serialized]) {
            db[groupeCible.id._serialized] = { participants_deja_contactes: [] };
        }
        
        const dejaFait = db[groupeCible.id._serialized].participants_deja_contactes;
        const membresDuGroupe = groupeCible.participants || [];

        console.log(`📊 Statistiques du groupe :`);
        console.log(`   - Total membres       : ${membresDuGroupe.length}`);
        console.log(`   - Déjà contactés (BDD): ${dejaFait.length}`);
        
        // --- FILTRES DE RIGOUREUX ---
        const moi_meme = client.info.wid._serialized;
        
        let membresRestants = membresDuGroupe.filter(participant => {
            const pId = participant.id._serialized;
            // 1. Est-ce moi ?
            if (pId === moi_meme) return false;
            // 2. Déjà contacté ?
            if (dejaFait.includes(pId)) return false;
            // 3. Dans la liste d'exclusion (.env) ?
            if (excludedList.includes(pId)) return false;

            return true;
        });

        console.log(`   - Éligibles ce tour   : ${membresRestants.length}\n`);

        if (membresRestants.length === 0) {
            console.log("🟢 TERMINÉ : Aucun membre éligible à contacter dans ce groupe ! BDD à jour.");
            process.exit(0);
        }

        // On prend seulement un "BATCH" (Lot) pour cette session
        const contactsAEnvoyer = membresRestants.slice(0, EXECUTION_BATCH_SIZE);
        console.log(`🚀 DEBUT DE LA CAMPAGNE : Traitement de ${contactsAEnvoyer.length} contacts (Batch de ${EXECUTION_BATCH_SIZE})\n`);

        let compteEnvoiCeTour = 0;

        for (const membre of contactsAEnvoyer) {
            // Re-vérification de sécurité temporelle
            if (!estHeureAutorisee()) {
                console.log(`\n🛑 PAUSE: Fin des horaires d'envoi autorisés atteinte.`);
                break;
            }

            const cibleId = membre.id._serialized;

            try {
                // Info Contact via WhatsApp pour obtenir son nom public
                const contactInfo = await client.getContactById(cibleId);
                
                // Algorithme de recherche de nom
                let nomBrut = contactInfo.pushname || contactInfo.name || contactInfo.shortName || '';
                let prenomFormatte = formatNom(nomBrut);

                // Compilation du message
                const msgFinal = MESSAGE_TYPE.replace(/{prenom}/gi, prenomFormatte);

                if (SIMULATION_MODE) {
                    console.log(`[SIMULATION ✅] -> Message pour ${cibleId} (${prenomFormatte}):\n> "${msgFinal}"\n`);
                } else {
                    // VERITABLE ENVOI WHATSAPP APPEL D'API
                    await client.sendMessage(cibleId, msgFinal);
                    console.log(`[ENVOI RÉEL ✅] -> Message envoyé à ${prenomFormatte} (${cibleId})`);
                }

                // Toujours mettre à jour la BDD même en simu pour tester totalement le Workflow
                dejaFait.push(cibleId);
                sauveEtat(db);
                compteEnvoiCeTour++;

                // Si ce n'est pas la dernière itération, on applique le timer Humain (Anti-Ban)
                if (compteEnvoiCeTour < contactsAEnvoyer.length) {
                    console.log(`   ⏳ Anti-Spam activé... Action mimétique de frappe et réflexion en cours...`);
                    await randomSleep(DELAY_MIN, DELAY_MAX);
                }

            } catch (errBot) {
                console.error(`\n❌ ERREUR ECHEC d'envoi vers ${cibleId} ->`, errBot.message);
            }
        }

        console.log(`\n🎉 FIN DU LOT : ${compteEnvoiCeTour} messages traités avec succès durant cette session.\n`);
        
        // Arrêt propre du robot pour ne pas laisser de zombie puppeteer
        client.destroy();
        process.exit(0);

    } catch (eGros) {
        console.error("FATAL ERROR dans le traitement principal :", eGros);
        process.exit(1);
    }
});

client.on('disconnected', (reason) => {
    console.error(`\n💀 DÉCONNEXION FATALE : Le téléphone s'est déconnecté (${reason}). Veuillez vérifier le réseau ou rescanner.`);
});

// Lancement du client 
client.initialize();
