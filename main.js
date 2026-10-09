const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createBackend } = require('./backend');

const customUserData = app.commandLine.getSwitchValue('user-data-dir');
if (customUserData) app.setPath('userData', path.resolve(customUserData));

let mainWindow;
let closing = false;
const indexURL = pathToFileURL(path.join(__dirname, 'workspace.html')).href;
const backend = createBackend(app.isPackaged ? path.join(process.resourcesPath, 'ffmpeg') : path.join(__dirname, 'ffmpeg'));

function trusted(event) {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || event.senderFrame.url.split('#')[0] !== indexURL) throw new Error('Untrusted IPC caller');
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1440,
        height: 960,
        minWidth: 720,
        minHeight: 600,
        show: false,
        backgroundColor: '#f5f6f8',
        icon: path.join(__dirname, 'icon.ico'),
        webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true }
    });
    mainWindow.loadFile('workspace.html');
    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.webContents.on('will-navigate', (event, url) => { if (url.split('#')[0] !== indexURL) event.preventDefault(); });
    // The sandboxed preview frame cannot leave the local service; a refused external load is the creative's exit.
    mainWindow.webContents.on('did-fail-load', (event, code, description, url, isMainFrame) => {
        if (!isMainFrame && /^https?:/i.test(url) && new URL(url).hostname !== '127.0.0.1') mainWindow?.webContents.send('preview-navigation-blocked', url.slice(0, 2000));
    });
    mainWindow.on('closed', () => { mainWindow = null; });
}

ipcMain.handle('extract-creative-for-preview', (event, data) => { trusted(event); return backend.extractCreative(data); });
ipcMain.handle('release-preview', (event, token) => { trusted(event); return backend.releasePreview(token); });
ipcMain.handle('analyze-video', (event, data) => { trusted(event); return backend.analyzeVideo(data); });
ipcMain.handle('cancel-analyses', event => { trusted(event); backend.cancelAnalyses(); });
ipcMain.handle('open-documentation', (event, url) => {
    trusted(event);
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !['support.google.com', 'uiverse.io'].includes(parsed.hostname)) throw new Error('Unsupported documentation URL');
    return shell.openExternal(parsed.href);
});

app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    await backend.start();
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}).catch(error => { console.error(error); app.quit(); });

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', event => {
    if (closing) return;
    event.preventDefault();
    closing = true;
    backend.close().finally(() => app.quit());
});