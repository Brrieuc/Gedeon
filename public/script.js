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
let pendingSelectedMemberIds = []; 
let igScrapedUsers = []; // Stocker les abonnés scrapés

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

// Instagram Elements
const igLoginContainer    = document.getElementById('ig-login-container');
const igStatusBadge     = document.getElementById('ig-connection-status');
const igLoginForm       = document.getElementById('ig-login-form');
const btnIgLogin        = document.getElementById('btn-ig-login');
const igScreenshotImg   = document.getElementById('ig-screenshot-img');
const igPreviewPlaceholder = document.getElementById('ig-preview-placeholder');
const ig2faContainer    = document.getElementById('ig-2fa-container');
const ig2faForm         = document.getElementById('ig-2fa-form');
const btnIg2faSubmit    = document.getElementById('btn-ig-2fa-submit');
const igDashboardContainer = document.getElementById('ig-dashboard-container');
const btnIgLogout       = document.getElementById('btn-ig-logout');
const igScrapedCount    = document.getElementById('ig-scraped-count');
const igFollowedToday      = document.getElementById('ig-followed-today');

// ─── LOGS & SOCKET HELPER ───────────────────────────────────────────────────
function appendLog(msg, type = 'info', consoleId = 'console-output') {
    const target = document.getElementById(consoleId);
    if (!target) return;
    const line = document.createElement('div');
    line.className = `log-line ${type}`;
    line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    target.appendChild(line);
    target.scrollTop = target.scrollHeight;
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
const sidebar = document.getElementById('sidebar');
const viewTitle = document.getElementById('view-title');

function showView(viewName) {
    // Hide all views
    document.querySelectorAll('.view').forEach(v => v.style.display = 'none');
    
    // Reset sidebar active states
    document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));

    if (viewName === 'launcher') {
        document.getElementById('view-launcher').style.display = 'flex';
        document.getElementById('nav-launcher').classList.add('active');
        viewTitle.textContent = 'Accueil';
        btnBackHome.style.display = 'none';
        currentCampaignId = null;
    } else if (viewName === 'home') {
        document.getElementById('view-home').style.display = 'flex';
        document.getElementById('nav-whatsapp').classList.add('active');
        viewTitle.textContent = 'WhatsApp - Mes Campagnes';
        btnBackHome.style.display = 'none';
        currentCampaignId = null;
        renderCampaignsGrid();
    } else if (viewName === 'instagram') {
        document.getElementById('view-instagram').style.display = 'flex';
        document.getElementById('nav-instagram').classList.add('active');
        viewTitle.textContent = 'Instagram - Automatisation';
        btnBackHome.style.display = 'none';
        currentCampaignId = null;
        // Afficher par défaut le container de login pour éviter l'écran vide
        if (igLoginContainer) igLoginContainer.style.display = 'block';
        if (igDashboardContainer) igDashboardContainer.style.display = 'none';
        // Init IG session
        socket.emit('ig_init');
    } else if (viewName === 'dashboard') {
        document.getElementById('view-dashboard').style.display = 'grid';
        document.getElementById('nav-whatsapp').classList.add('active');
        viewTitle.textContent = 'WhatsApp - Configuration';
        btnBackHome.style.display = 'inline-block';
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

// --- Instagram Hooks ---
socket.on('ig_status', (data) => {
    console.info('[IG] Status:', data);
    if (igStatusBadge) {
        igStatusBadge.textContent = data.desc;
        igStatusBadge.className = 'status-badge ' + data.state.toLowerCase();
    }

    const igConnectedUser = document.getElementById('ig-connected-user');
    if (igConnectedUser) {
        if (data.state === 'CONNECTED') {
            igConnectedUser.textContent = data.username ? `@${data.username}` : 'Recherche du compte...';
        } else {
            igConnectedUser.textContent = '';
        }
    }
    
    if (data.state === 'CONNECTED') {
        igLoginContainer.style.display = 'none';
        igDashboardContainer.style.display = 'grid';
    } else {
        igLoginContainer.style.display = 'block';
        igDashboardContainer.style.display = 'none';
        if (btnIgLogin) {
            btnIgLogin.disabled = false;
            btnIgLogin.innerHTML = '<span>Se connecter</span>';
        }
    }
});

socket.on('ig_screenshot', (base64) => {
    if (igScreenshotImg && igPreviewPlaceholder) {
        igScreenshotImg.src = `data:image/jpeg;base64,${base64}`;
        igScreenshotImg.style.display = 'block';
        igPreviewPlaceholder.style.display = 'none';
        
        // Initialiser les contrôles distants une seule fois
        if (!igScreenshotImg.dataset.active) {
            igScreenshotImg.dataset.active = "true";
            setupRemoteControls();
        }
    }
});

function setupRemoteControls() {
    igScreenshotImg.style.cursor = "crosshair";
    
    // Clic distant
    igScreenshotImg.onclick = (e) => {
        const rect = igScreenshotImg.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * 100;
        const y = ((e.clientY - rect.top) / rect.height) * 100;
        socket.emit('ig_remote_click', { x, y });
    };

    // Clavier distant
    window.addEventListener('keydown', (e) => {
        // Seulement si on est sur l'onglet Instagram et qu'on survole l'image
        const isIgVisible = document.getElementById('ig-view').style.display !== 'none';
        const isHovering = igScreenshotImg.matches(':hover');
        
        if (isIgVisible && isHovering) {
            if (e.key.length === 1) {
                socket.emit('ig_remote_type', { text: e.key });
            } else if (['Enter', 'Backspace', 'Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
                e.preventDefault();
                socket.emit('ig_remote_key', { key: e.key });
            }
        }
    });
}

socket.on('ig_code_required', () => {
    ig2faContainer.style.display = 'block';
    appendLog('Code de sécurité requis pour Instagram.', 'warn', 'ig-console-output');
});

socket.on('ig_login_result', (res) => {
    if (btnIgLogin) {
        btnIgLogin.disabled = false;
        btnIgLogin.innerHTML = '<span>Se connecter via Gédéon</span>';
    }
    
    if (!res.success) {
        appendLog(`Erreur connexion IG: ${res.message}`, 'error', 'ig-console-output');
        alert(`Erreur: ${res.message}`);
    } else if (res.codeRequired) {
        ig2faContainer.style.display = 'block';
    } else {
        appendLog('Connexion Instagram réussie !', 'success', 'ig-console-output');
    }
});

socket.on('ig_submit_code_result', (res) => {
    if (res.success) {
        ig2faContainer.style.display = 'none';
        appendLog('Code validé. Instagram prêt.', 'success', 'ig-console-output');
    } else {
        alert(`Erreur code: ${res.message}`);
    }
});

socket.on('ig_scraped_data', (data) => {
    igScrapedUsers = data;
    if (igScrapedCount) igScrapedCount.textContent = data.length;
});

socket.on('log_ig', (data) => appendLog(data.msg, data.type, 'ig-console-output'));

// ─── AUTHENTIFICATION ─────────────────────────────────────────────────────────
auth.onAuthStateChanged(user => {
    if (user) {
        currentUser = user;
        viewLogin.style.display = 'none';
        appContent.style.display = 'flex';
        sidebar.style.display = 'flex'; // Show sidebar after login
        if (userNameDisplay) userNameDisplay.textContent = user.displayName || user.email;
        if (userPhotoDisplay && user.photoURL) {
            userPhotoDisplay.src = user.photoURL;
            userPhotoDisplay.style.display = 'block';
        }
        showView('launcher'); // Start on launcher
        forceSyncCampaigns();
    } else {
        currentUser = null;
        viewLogin.style.display = 'flex';
        appContent.style.display = 'none';
        sidebar.style.display = 'none'; // Hide sidebar
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
// ─── INSTAGRAM ACTIONS ────────────────────────────────────────────────────────
if (igLoginForm) {
    igLoginForm.onsubmit = (e) => {
        e.preventDefault();
        const username = document.getElementById('ig-username').value;
        const password = document.getElementById('ig-password').value;
        
        btnIgLogin.disabled = true;
        btnIgLogin.innerHTML = '<span class="loader-sm"></span> Connexion en cours...';
        
        appendLog(`Connexion à Instagram en cours...`, 'info', 'ig-console-output');
        socket.emit('ig_login', { username, password });
    };
}

const btnIgForceLogin = document.getElementById('btn-ig-force-login');
if (btnIgForceLogin) {
    btnIgForceLogin.onclick = () => {
        appendLog('Réinitialisation vers la page de login Instagram...', 'info', 'ig-console-output');
        socket.emit('ig_force_login');
    };
}

if (ig2faForm) {
    ig2faForm.onsubmit = (e) => {
        e.preventDefault();
        const code = document.getElementById('ig-2fa-code').value;
        socket.emit('ig_submit_code', { code });
    };
}

if (btnIgLogout) {
    btnIgLogout.onclick = () => {
        if (confirm("Se déconnecter d'Instagram ?")) socket.emit('ig_logout');
    };
}

if (document.getElementById('ig-config-form')) {
    document.getElementById('ig-config-form').onsubmit = (e) => {
        e.preventDefault();
        const config = {
            target: document.getElementById('ig-target-account').value,
            autoFollow: document.getElementById('ig-auto-follow').checked,
            unfollowNotFollowing: document.getElementById('ig-unfollow-not-following').checked,
            unfollowFollowing: document.getElementById('ig-unfollow-following').checked,
            delayMin: parseInt(document.getElementById('ig-delay-min').value),
            delayMax: parseInt(document.getElementById('ig-delay-max').value),
            scrapedUsers: igScrapedUsers
        };
        emitSecure('ig_start_campaign', config);
    };
}

if (document.getElementById('btn-ig-scrape')) {
    document.getElementById('btn-ig-scrape').onclick = () => {
        const target = document.getElementById('ig-target-account').value;
        if (!target) return alert('Source requise !');
        appendLog(`Lancement du scraping pour ${target}...`, 'info', 'ig-console-output');
        emitSecure('ig_scrape_followers', { target });
    };
}
