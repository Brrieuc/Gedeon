const { app, BrowserWindow } = require('electron');
const path = require('path');
const { fork } = require('child_process');
const { autoUpdater } = require("electron-updater");

let mainWindow;
let serverProcess;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "Gédéon - Automatisation WhatsApp",
    icon: path.join(__dirname, 'public', 'favicon.ico'), // Optionnel
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // Lancer le serveur Express en arrière-plan
  serverProcess = fork(path.join(__dirname, 'server.js'), [], {
    env: { ...process.env, PORT: 3000 }
  });

  serverProcess.on('message', (msg) => {
    console.log('Serveur:', msg);
  });

  // Attendre un peu que le serveur démarre
  setTimeout(() => {
    mainWindow.loadURL('http://localhost:3000');
  }, 2000);

  mainWindow.on('closed', function () {
    mainWindow = null;
  });
}

app.on('ready', () => {
    createWindow();
    autoUpdater.checkForUpdatesAndNotify();
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') {
    app.quit();
  }
  if (serverProcess) serverProcess.kill();
});

app.on('activate', function () {
  if (mainWindow === null) {
    createWindow();
  }
});
