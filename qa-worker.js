const qa = require('./qa-core');
self.onmessage = event => {
    try {
        const data = event.data;
        const value = data.type === 'gif' ? qa.inspectGif(data.buffer) : [...qa.analyzeScripts(data.scripts, data.mode, data.incomplete), qa.analyzeAnimation(data.styles, data.duration)];
        self.postMessage({ value });
    } catch (error) { self.postMessage({ error: error.message }); }
};