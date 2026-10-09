const { contextBridge, ipcRenderer } = require('electron');
 
contextBridge.exposeInMainWorld('electronAPI', {
    extractCreative: data => ipcRenderer.invoke('extract-creative-for-preview', data),
    releasePreview: token => ipcRenderer.invoke('release-preview', token),
    analyzeVideo: (buffer, filename) => ipcRenderer.invoke('analyze-video', { buffer, filename }),
    cancelAnalyses: () => ipcRenderer.invoke('cancel-analyses'),
    openDocumentation: url => ipcRenderer.invoke('open-documentation', url),
    onPreviewNavigation: callback => ipcRenderer.on('preview-navigation-blocked', (_event, url) => callback(String(url)))
});
 