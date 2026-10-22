const { app, BrowserWindow, ipcMain, shell, session, clipboard, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { createBackend } = require('./backend');
const { isBelowMinimum } = require('./semver');

const APP_VERSION = require('./package.json').version;
const POLICY_URL = 'https://raw.githubusercontent.com/alexsplithappens/creative-qa-releases/main/policy.json';

let autoUpdater = null;
let updateState = 'idle';
let lastUpdateCheck = 'not run';

const customUserData = app.commandLine.getSwitchValue('user-data-dir');
if (customUserData) app.setPath('userData', path.resolve(customUserData));

let mainWindow;
let closing = false;
const indexURL = pathToFileURL(path.join(__dirname, 'workspace.html')).href;
const ffmpegDirectory = app.isPackaged ? path.join(process.resourcesPath, 'ffmpeg') : path.join(__dirname, 'ffmpeg');
const backend = createBackend(ffmpegDirectory);
const logDirectory = () => path.join(app.getPath('userData'), 'logs');

function log(level, message) {
    try {
        const file = path.join(logDirectory(), 'app.log');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (fs.existsSync(file) && fs.statSync(file).size > 512 * 1024) fs.renameSync(file, `${file}.old`);
        fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${String(message).slice(0, 2000)}\n`);
    } catch (_) {}
}

function diagnostics() {
    let recent = '';
    try { recent = fs.readFileSync(path.join(logDirectory(), 'app.log'), 'utf8').trim().split('\n').slice(-30).join('\n'); } catch (_) {}
    const tool = name => fs.existsSync(path.join(ffmpegDirectory, name)) ? 'found' : 'MISSING';
    return [
        "Sunshine's Creative QA Tool", `Version: ${APP_VERSION}${app.isPackaged ? '' : ' (development)'}`,
        `Electron ${process.versions.electron} / Chromium ${process.versions.chrome}`, `Windows: ${os.release()} ${os.arch()}`, `Locale: ${app.getLocale()}`,
        `Memory: ${Math.round(os.freemem() / 1048576)} MB free of ${Math.round(os.totalmem() / 1048576)} MB`, `ffmpeg.exe: ${tool('ffmpeg.exe')}  ffprobe.exe: ${tool('ffprobe.exe')}`,
        `Updater: ${autoUpdater ? 'enabled' : 'disabled'}  State: ${updateState}  Last check: ${lastUpdateCheck}`,
        '', 'Recent log:', recent || '(empty)'
    ].join('\n');
}

process.on('uncaughtExceptionMonitor', error => log('ERROR', error.stack || error));

function trusted(event) {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || event.senderFrame.url.split('#')[0] !== indexURL) throw new Error('Untrusted IPC caller');
}

function sendToRenderer(channel, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function sendUpdateStatus(status) {
    updateState = status.state;
    sendToRenderer('update-status', status);
}

function normaliseNotes(notes) {
    if (Array.isArray(notes)) return notes.map(entry => entry?.note || '').filter(Boolean).join('\n').slice(0, 5000);
    return typeof notes === 'string' ? notes.slice(0, 5000) : undefined;
}

function setupUpdater() {
    if (!app.isPackaged || autoUpdater) return;
    ({ autoUpdater } = require('electron-updater'));
    autoUpdater.logger = { info: m => log('UPDATER', m), warn: m => log('UPDATER-WARN', m), error: m => log('UPDATER-ERROR', m), debug: () => {} };
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('checking-for-update', () => sendUpdateStatus({ state: 'checking' }));
    autoUpdater.on('update-available', info => { lastUpdateCheck = `${new Date().toISOString()} update ${info.version} available`; sendUpdateStatus({ state: 'available', version: info.version, notes: normaliseNotes(info.releaseNotes) }); });
    autoUpdater.on('update-not-available', () => { lastUpdateCheck = `${new Date().toISOString()} up to date`; sendUpdateStatus({ state: 'none' }); });
    autoUpdater.on('download-progress', progress => sendUpdateStatus({ state: 'downloading', percent: Math.round(progress.percent) }));
    autoUpdater.on('update-downloaded', info => sendUpdateStatus({ state: 'ready', version: info.version, notes: normaliseNotes(info.releaseNotes) }));
    autoUpdater.on('error', error => { lastUpdateCheck = `${new Date().toISOString()} error: ${error?.message}`; sendUpdateStatus({ state: 'error', message: String(error?.message || error).slice(0, 500) }); });
}

function checkForUpdates() {
    if (!autoUpdater) return Promise.resolve();
    return autoUpdater.checkForUpdates().catch(error => log('UPDATER-ERROR', error?.message || error));
}

async function checkMinimumVersion() {
    try {
        const response = await net.fetch(POLICY_URL, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const policy = await response.json();
        if (isBelowMinimum(APP_VERSION, policy.minVersion)) {
            log('WARN', `Version ${APP_VERSION} is below required ${policy.minVersion}`);
            sendToRenderer('update-required', { minVersion: String(policy.minVersion), message: typeof policy.message === 'string' ? policy.message.slice(0, 1000) : '' });
        }
    } catch (error) {
        log('WARN', `Minimum version check failed, allowing use: ${error?.message || error}`);
    }
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
    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
        setupUpdater();
        checkForUpdates();
    });
    mainWindow.webContents.once('did-finish-load', checkMinimumVersion);
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.webContents.on('will-navigate', (event, url) => { if (url.split('#')[0] !== indexURL) event.preventDefault(); });
    // The sandboxed preview frame cannot leave the local service; a refused external load is the creative's exit.
    mainWindow.webContents.on('did-fail-load', (event, code, description, url, isMainFrame) => {
        if (!isMainFrame && /^https?:/i.test(url) && new URL(url).hostname !== '127.0.0.1') mainWindow?.webContents.send('preview-navigation-blocked', url.slice(0, 2000));
    });
    mainWindow.on('closed', () => { mainWindow = null; });
    mainWindow.webContents.on('render-process-gone', (_event, details) => log('ERROR', `Renderer process gone: ${details.reason}`));
}

ipcMain.handle('extract-creative-for-preview', (event, data) => { trusted(event); return backend.extractCreative(data); });
ipcMain.handle('release-preview', (event, token) => { trusted(event); return backend.releasePreview(token); });
ipcMain.handle('analyze-video', (event, data) => { trusted(event); return backend.analyzeVideo(data); });
ipcMain.handle('cancel-analyses', event => { trusted(event); backend.cancelAnalyses(); });
ipcMain.handle('app-info', event => { trusted(event); return { version: APP_VERSION }; });
ipcMain.handle('log-error', (event, message) => { trusted(event); log('RENDERER', message); });
ipcMain.handle('copy-diagnostics', event => { trusted(event); clipboard.writeText(diagnostics()); });
ipcMain.handle('install-update', event => { trusted(event); if (autoUpdater) autoUpdater.quitAndInstall(); });
ipcMain.handle('check-for-updates', async event => { trusted(event); await checkForUpdates(); });
ipcMain.handle('open-log-folder', async event => { trusted(event); fs.mkdirSync(logDirectory(), { recursive: true }); const failure = await shell.openPath(logDirectory()); if (failure) throw new Error(failure); });
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
    log('INFO', `Started v${APP_VERSION} on ${os.release()}`);
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