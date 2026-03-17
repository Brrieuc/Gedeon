// Firebase Configuration
const firebaseConfig = {
  apiKey: "AIzaSyBNkbLMeK5sTDXW8-NvMdZ-5VZTL_a0X6o",
  authDomain: "gedeon-larbin.firebaseapp.com",
  projectId: "gedeon-larbin",
  storageBucket: "gedeon-larbin.firebasestorage.app",
  messagingSenderId: "750672153668",
  appId: "1:750672153668:web:1537bebe32799e71590011",
  measurementId: "G-8QV40QXEHD"
};

// INITIALIZE FIREBASE
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

// ─── ÉTAT GLOBAL ───────────────────────────────────────────────────────────
const socket = io();
let currentUser = null;
let globalGroups = [];
let globalCampaigns = [];
let currentParticipants = [];
let currentCampaignId = null;
let campaignsLoadedOnce = false;
let socketConnected = false;
let pendingSelectedMemberIds = []; // Pour restaurer la sélection après chargement des membres

// ─── ÉLÉMENTS UI ────────────────────────────────────────────────────────────
const statusBadge        = document.getElementById('global-status');
const statusDot          = document.getElementById('connection-status-dot');
const qrContainer        = document.getElementById('qr-container');
const qrcodeDiv          = document.getElementById('qrcode');
const qrPlaceholder      = document.querySelector('.qr-placeholder');
const groupSelect        = document.getElementById('groupName');
const btnStart           = document.getElementById('btn-start');
const btnStop            = document.getElementById('btn-stop');
const consoleOutput      = document.getElementById('console-output');
const membersContainer   = document.getElementById('members-selection-container');
const membersList        = document.getElementById('members-list');
const selectionSummary   = document.getElementById('selection-summary');
const btnSelectAll       = document.getElementById('select-all');
const btnUnselectAll     = document.getElementById('unselect-all');
const btnLogout          = document.getElementById('btn-logout');
const btnLogoutGoogle    = document.getElementById('btn-logout-google');
const btnLoginGoogle     = document.getElementById('btn-login-google');
const viewLogin          = document.getElementById('view-login');
const appContent         = document.getElementById('app-content');
const userNameDisplay    = document.getElementById('user-name');
const userPhotoDisplay   = document.getElementById('user-photo');
const memberSearch       = document.getElementById('member-search');
const btnBackHome        = document.getElementById('btn-back-to-home');
const viewHome           = document.getElementById('view-home');
const viewDashboard      = document.getElementById('view-dashboard');
const campaignsGrid      = document.getElementById('campaigns-grid');
const cardNewCampaign    = document.getElementById('card-new-campaign');
const currentCampaignNameDisplay = document.getElementById('current-campaign-name');
const form               = document.getElementById('config-form');
const statsContainer     = document.getElementById('stats-container');
const statTotal          = document.getElementById('stat-total');
const statDone           = document.getElementById('stat-done');
const statSession        = document.getElementById('stat-session');
const btnSaveCampaign    = document.getElementById('btn-save-campaign');
const btnDeleteCampaign  = document.getElementById('btn-delete-campaign');
const btnRefreshCampaigns = document.getElementById('btn-refresh-campaigns');

// ─── LOGS & SOCKET HELPER ───────────────────────────────────────────────────
function appendLog(msg, type = 'info') {
    if (!consoleOutput) return;
    const line = document.createElement('div');
    line.className = `log-line ${type}`;
    line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    consoleOutput.appendChild(line);
    consoleOutput.scrollTop = consoleOutput.scrollHeight;
}

function emitSecure(event, data = {}) {
    if (!currentUser) {
        console.warn(`[GEDEON] Tentative d'envoi "${event}" sans UID.`);
        return;
    }
    console.log(`[GEDEON] Émission sécurisée: ${event} pour ${currentUser.uid}`);
    socket.emit(event, { ...data, uid: currentUser.uid });
}

// ─── LOGIQUE DE CHARGEMENT ROBUSTE ───────────────────────────────────────────
// Cette fonction tourne en boucle tant que la liste est vide ou pas chargée une fois
function forceSyncCampaigns() {
    if (!currentUser || !socketConnected) return;
    if (campaignsLoadedOnce && globalCampaigns.length > 0) return;

    console.log("[GEDEON] Tentative de synchronisation forcée des campagnes...");
    emitSecure('get_campaigns');

    // On réessaie dans 2 secondes si le serveur n'a toujours pas répondu
    if (!campaignsLoadedOnce) {
        setTimeout(forceSyncCampaigns, 2000);
    }
}

// ─── VUES ───────────────────────────────────────────────────────────────────
function showView(viewName) {
    if (viewName === 'home') {
        viewHome.style.display   = 'flex';
        viewDashboard.style.display = 'none';
        btnBackHome.style.display = 'none';
        currentCampaignId = null;
        renderCampaignsGrid();
    } else {
        viewHome.style.display      = 'none';
        viewDashboard.style.display = 'grid';
        btnBackHome.style.display   = 'inline-block';
    }
}

function renderCampaignsGrid() {
    campaignsGrid.querySelectorAll('.campaign-card:not(.add-new)').forEach(c => c.remove());

    if (globalCampaigns.length === 0 && campaignsLoadedOnce) {
        appendLog('Aucune campagne trouvée dans le cloud. Créez-en une !', 'info');
    }

    globalCampaigns.forEach(camp => {
        const card = document.createElement('div');
        card.className = 'campaign-card';
        card.innerHTML = `
            <button class="card-delete-btn" title="Supprimer">✕</button>
            <h3>${camp.name}</h3>
            <div class="card-meta">
                Groupe: ${camp.groupName || 'Non défini'}<br>
                Cibles: ${camp.selectedMemberIds ? camp.selectedMemberIds.length : 0}
            </div>
        `;
        card.onclick = () => loadCampaign(camp.id);
        card.querySelector('.card-delete-btn').onclick = (e) => {
            e.stopPropagation();
            if (confirm(`Supprimer "${camp.name}" ?`)) emitSecure('delete_campaign', { id: camp.id });
        };
        campaignsGrid.insertBefore(card, cardNewCampaign);
    });
}

function updateSelectionCount() {
    if (!selectionSummary) return;
    const checked = document.querySelectorAll('.member-item input:checked').length;
    const total = document.querySelectorAll('.member-item').length;
    selectionSummary.textContent = `${checked} membre(s) sélectionné(s) sur ${total}`;
}

function renderMembersList(participants) {
    if (!membersList) return;
    currentParticipants = participants;
    membersList.innerHTML = '';
    
    participants.forEach(p => {
        const div = document.createElement('div');
        div.className = 'member-item';
        div.dataset.name = (p.name || p.pushname || p.number || '').toLowerCase();
        
        const isChecked = pendingSelectedMemberIds.includes(p.id) ? 'checked' : '';
        
        div.innerHTML = `
            <input type="checkbox" value="${p.id}" id="chk-${p.id}" ${isChecked}>
            <label for="chk-${p.id}">
                <span class="member-name">${p.name || p.pushname || 'Sans Nom'}</span>
                <span class="member-number">${p.number || p.id.split('@')[0]}</span>
            </label>
        `;
        membersList.appendChild(div);
    });

    membersContainer.style.display = 'block';
    updateSelectionCount();

    // Attacher les events aux nouveaux checkboxes
    membersList.querySelectorAll('input').forEach(chk => {
        chk.onchange = updateSelectionCount;
    });
}

function loadCampaign(id) {
    const camp = globalCampaigns.find(c => c.id === id);
    if (!camp) return;

    currentCampaignId = id;
    currentCampaignNameDisplay.textContent = camp.name;
    pendingSelectedMemberIds = camp.selectedMemberIds || [];

    groupSelect.value = camp.groupName || '';
    document.getElementById('messageTemplate').value  = camp.messageTemplate || '';
    document.getElementById('batchSize').value        = camp.batchSize || 20;
    document.getElementById('simulationMode').value   = (camp.simulationMode === false) ? 'false' : 'true';
    document.getElementById('excludedNumbers').value  = camp.excludedNumbers || '';
    document.getElementById('hourStart').value        = camp.hourStart ?? 9;
    document.getElementById('hourEnd').value          = camp.hourEnd ?? 19;
    document.getElementById('delayMin').value         = camp.delayMin ?? 15;
    document.getElementById('delayMax').value         = camp.delayMax ?? 45;

    if (camp.groupName) {
        const found = globalGroups.find(g => g.name === camp.groupName);
        if (found) {
            emitSecure('get_group_participants', { groupId: found.id });
        } else {
            // Le groupe n'est pas encore chargé ou absent du compte
            membersContainer.style.display = 'none';
        }
    } else {
        membersContainer.style.display = 'none';
    }
    showView('dashboard');
}

// ─── SOCKET LISTENERS ───────────────────────────────────────────────────────
socket.on('connect', () => {
    socketConnected = true;
    console.log("[GEDEON] Socket connecté.");
    if (currentUser) forceSyncCampaigns();
});

socket.on('disconnect', () => {
    socketConnected = false;
});

socket.on('campaigns_list', (campaigns) => {
    console.log(`[GEDEON] Réception de ${campaigns.length} campagnes.`);
    globalCampaigns = campaigns;
    campaignsLoadedOnce = true;
    renderCampaignsGrid();
});

socket.on('status', (data) => {
    if (statusBadge) {
        statusBadge.textContent = data.desc;
        statusBadge.className = 'status-badge ' + data.state.toLowerCase();
    }

    // Comportement par défaut
    if (qrContainer) qrContainer.style.display = 'none';
    if (statsContainer) statsContainer.style.display = 'none';
    if (btnStart) btnStart.disabled = true;
    if (btnStop) btnStop.disabled = true;

    if (data.state === 'CONNECTED') {
        if (statusDot) statusDot.classList.add('active');
        if (qrContainer) qrContainer.style.display = 'none';
        if (statsContainer) statsContainer.style.display = 'grid';
        if (btnStart) {
            btnStart.disabled = false;
            btnStart.textContent = '🚀 Lancer la Session';
        }
    } else if (data.state === 'WORKING') {
        if (statusDot) statusDot.classList.add('active');
        if (statsContainer) statsContainer.style.display = 'grid';
        if (btnStart) {
            btnStart.disabled = true;
            btnStart.textContent = '⏳ Envoi en cours...';
        }
        if (btnStop) btnStop.disabled = false;
    } else if (data.state === 'QR') {
        if (qrContainer) qrContainer.style.display = 'flex';
        if (statsContainer) statsContainer.style.display = 'none';
    }

    if (data.msg) appendLog(data.msg, data.type || 'info');
});

socket.on('log', (data) => appendLog(data.msg, data.type));

socket.on('stats', (data) => {
    if (statTotal)   statTotal.textContent   = data.total;
    if (statDone)    statDone.textContent    = data.done;
    if (statSession) statSession.textContent = data.session;
});

socket.on('qr', (qrCodeData) => {
    qrPlaceholder.style.display = 'none';
    qrcodeDiv.innerHTML = '';
    new QRCode(qrcodeDiv, { text: qrCodeData, width: 180, height: 180 });
});

socket.on('groups', (groups) => {
    globalGroups = groups;
    groupSelect.innerHTML = '<option value="">-- Sélectionnez un groupe --</option>';
    groups.forEach(g => {
        const opt = document.createElement('option');
        opt.value = g.name; opt.textContent = g.name;
        groupSelect.appendChild(opt);
    });
});

socket.on('campaign_saved', (id) => {
    emitSecure('get_campaigns'); // Recharger toute la liste
});

socket.on('group_participants', (data) => {
    // Le serveur envoie { groupId, participants, dejaFait }
    renderMembersList(data.participants || []);
});

// ─── AUTHENTIFICATION ─────────────────────────────────────────────────────────
auth.onAuthStateChanged(user => {
    if (user) {
        currentUser = user;
        viewLogin.style.display = 'none';
        appContent.style.display = 'flex';
        if (userNameDisplay) userNameDisplay.textContent = user.displayName || user.email;
        showView('home');
        forceSyncCampaigns();
    } else {
        currentUser = null;
        viewLogin.style.display = 'flex';
        appContent.style.display = 'none';
    }
});

if (btnLoginGoogle) {
    btnLoginGoogle.onclick = () => {
        const provider = new firebase.auth.GoogleAuthProvider();
        auth.signInWithPopup(provider);
    };
}

if (btnLogoutGoogle) btnLogoutGoogle.onclick = () => auth.signOut();
if (btnBackHome) btnBackHome.onclick = () => showView('home');
if (btnRefreshCampaigns) btnRefreshCampaigns.onclick = () => forceSyncCampaigns();

if (groupSelect) groupSelect.onchange = () => {
    const gn = groupSelect.value;
    const found = globalGroups.find(g => g.name === gn);
    if (found) {
        appendLog(`Chargement des membres de "${gn}"...`, 'info');
        emitSecure('get_group_participants', { groupId: found.id });
    } else {
        membersContainer.style.display = 'none';
    }
};

if (memberSearch) memberSearch.oninput = (e) => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll('.member-item').forEach(div => {
        div.style.display = div.dataset.name.includes(q) ? 'flex' : 'none';
    });
};

// ─── ACTIONS FORMULAIRE ───────────────────────────────────────────────────────
if (btnSaveCampaign) btnSaveCampaign.onclick = () => {
    const selectedIds = Array.from(document.querySelectorAll('.member-item input:checked')).map(i => i.value);
    const config = {
        id: currentCampaignId,
        name: currentCampaignNameDisplay.textContent,
        groupName: groupSelect.value,
        messageTemplate: document.getElementById('messageTemplate').value,
        batchSize: parseInt(document.getElementById('batchSize').value),
        simulationMode: document.getElementById('simulationMode').value === 'true',
        excludedNumbers: document.getElementById('excludedNumbers').value,
        hourStart: parseInt(document.getElementById('hourStart').value),
        hourEnd: parseInt(document.getElementById('hourEnd').value),
        delayMin: parseInt(document.getElementById('delayMin').value),
        delayMax: parseInt(document.getElementById('delayMax').value),
        selectedMemberIds: selectedIds
    };
    emitSecure('save_campaign', config);
};

if (btnDeleteCampaign) btnDeleteCampaign.onclick = () => {
    if (currentCampaignId && confirm("Supprimer définitivement cette campagne ?")) {
        emitSecure('delete_campaign', { id: currentCampaignId });
        showView('home');
    }
};

if (btnStop) btnStop.onclick = () => {
    if (confirm("Arrêter la session en cours ?")) {
        emitSecure('stop_campaign');
    }
};

if (btnLogout) btnLogout.onclick = () => {
    if (confirm("Déconnecter le compte WhatsApp ?")) {
        emitSecure('logout');
    }
};

if (form) form.onsubmit = async (e) => {
    e.preventDefault();
    if (!groupSelect.value) { alert('Sélectionnez un groupe !'); return; }

    const mediaInput = document.getElementById('mediaFile');
    let mediaData = null;
    if (mediaInput.files && mediaInput.files[0]) {
        const file = mediaInput.files[0];
        appendLog(`Préparation du média: ${file.name}...`, 'info');
        mediaData = await new Promise(r => {
            const rd = new FileReader();
            rd.onload = (ev) => r({ data: ev.target.result.split(',')[1], mimetype: file.type, filename: file.name });
            rd.readAsDataURL(file);
        });
    }

    const selectedIds = Array.from(document.querySelectorAll('.member-item input:checked')).map(i => i.value);
    const config = {
        groupName: groupSelect.value,
        messageTemplate: document.getElementById('messageTemplate').value,
        batchSize: parseInt(document.getElementById('batchSize').value),
        simulationMode: document.getElementById('simulationMode').value === 'true',
        excludedNumbers: document.getElementById('excludedNumbers').value,
        hourStart: parseInt(document.getElementById('hourStart').value),
        hourEnd: parseInt(document.getElementById('hourEnd').value),
        delayMin: parseInt(document.getElementById('delayMin').value),
        delayMax: parseInt(document.getElementById('delayMax').value),
        media: mediaData,
        selectedMemberIds: selectedIds
    };

    emitSecure('start_campaign', config);
};

cardNewCampaign.onclick = () => {
    const name = prompt('Nom de la nouvelle campagne :');
    if (!name) return;
    emitSecure('save_campaign', {
        name, groupName: '',
        messageTemplate: "Bonjour {prenom}, j'espère que tu vas bien ?",
        batchSize: 20, simulationMode: true, excludedNumbers: '',
        hourStart: 9, hourEnd: 19, delayMin: 15, delayMax: 45,
        selectedMemberIds: []
    });
};
