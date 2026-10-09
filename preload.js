const { contextBridge, ipcRenderer } = require('electron');
 
contextBridge.exposeInMainWorld('electronAPI', {
    extractCreative: data => ipcRenderer.invoke('extract-creative-for-preview', data),
    releasePreview: token => ipcRenderer.invoke('release-preview', token),
    analyzeVideo: (buffer, filename) => ipcRenderer.invoke('analyze-video', { buffer, filename }),
    cancelAnalyses: () => ipcRenderer.invoke('cancel-analyses'),
    openDocumentation: url => ipcRenderer.invoke('open-documentation', url),
    onPreviewNavigation: callback => ipcRenderer.on('preview-navigation-blocked', (_event, url) => callback(String(url))),
    getAppInfo: () => ipcRenderer.invoke('app-info'),
    logError: message => ipcRenderer.invoke('log-error', String(message).slice(0, 2000)),
    copyDiagnostics: () => ipcRenderer.invoke('copy-diagnostics'),
    openLogFolder: () => ipcRenderer.invoke('open-log-folder')
});
 