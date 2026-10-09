const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const JSZip = require('jszip');
const { LIMITS } = require('./qa-core');
const execute = promisify(execFile);
const MIME = { '.html': 'text/html', '.htm': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.xml': 'application/xml', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };

function safeRelativePath(name) {
    if (typeof name !== 'string' || !name || name.includes('\0') || name.includes('\\') || name.includes(':') || name.startsWith('/') || name.split('/').some(part => part === '..' || /^[. ]+$/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Unsafe asset path');
    return name;
}

function finite(value) {
    const number = Number.parseFloat(value);
    return Number.isFinite(number) ? number : null;
}

function previewInstrumentation(token) {
    return `<script>(function(){const token=${JSON.stringify(token)};const send=(kind,detail)=>parent.postMessage({creativeQA:token,kind,detail:String(detail).slice(0,2000)},'*');window.open=function(url){send('exit',url);return null;};document.addEventListener('click',function(event){const link=event.target.closest&&event.target.closest('a');if(link&&link.href){event.preventDefault();if(/^javascript:/i.test(link.href)){try{(0,eval)(decodeURIComponent(link.href.slice(11)));}catch(error){send('error',error.message);}}else send('exit',link.href);}},true);window.addEventListener('error',function(event){send('error',event.message||('Resource failed: '+(event.target.src||event.target.href||'unknown')));},true);window.addEventListener('unhandledrejection',function(event){send('error',event.reason);});send('loaded',location.pathname);var E;try{Object.defineProperty(window,'Enabler',{configurable:true,get:function(){return E;},set:function(v){E=v;if(v&&typeof v==='object')['exit','exitOverride','dynamicExit','dynamicExitOverride'].forEach(function(m){if(typeof v[m]==='function')v[m]=function(){send('exit','Enabler.'+m+'('+[].slice.call(arguments).join(', ')+')');};});}});}catch(error){}})();</script>`;
}

function createBackend(binaryDirectory) {
    const previews = new Map();
    const controllers = new Set();
    let root;
    let server;
    let port;
    async function start() {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'sunshine-qa-'));
        server = http.createServer(async (request, response) => {
            try {
                if (request.method !== 'GET' || !['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress) || request.headers.host !== `127.0.0.1:${port}`) throw new Error('Forbidden');
                const pathname = decodeURIComponent(new URL(request.url, `http://127.0.0.1:${port}`).pathname);
                const [, token, ...segments] = pathname.split('/');
                const preview = previews.get(token);
                if (!preview) throw new Error('Unknown preview');
                const relative = safeRelativePath(segments.join('/'));
                const contentType = MIME[path.extname(relative).toLowerCase()];
                if (!contentType) throw new Error('Unsupported resource');
                let content = await fs.readFile(path.join(preview.directory, relative));
                response.setHeader('Content-Type', contentType);
                response.setHeader('X-Content-Type-Options', 'nosniff');
                response.setHeader('Cache-Control', 'no-store');
                response.setHeader('Referrer-Policy', 'no-referrer');
                response.setHeader('Access-Control-Allow-Origin', '*');
                response.setHeader('Content-Security-Policy', "default-src 'self' https: data: blob:; script-src 'self' https: 'unsafe-inline' 'unsafe-eval'; connect-src 'self' https:; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'");
                if (contentType === 'text/html') {
                    const html = content.toString('utf8');
                    const instrumentation = previewInstrumentation(token);
                    content = Buffer.from(/<head\b[^>]*>/i.test(html) ? html.replace(/<head\b[^>]*>/i, match => match + instrumentation) : instrumentation + html);
                }
                response.end(content);
            } catch (_) {
                response.writeHead(404, { 'Content-Type': 'text/plain' });
                response.end('Preview resource unavailable');
            }
        });
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        port = server.address().port;
    }
    async function extractCreative({ zipBuffer, mainHtmlFileName }) {
        if (!root) throw new Error('Preview service is not ready');
        if (!zipBuffer || zipBuffer.byteLength > LIMITS.expandedBytes) throw new Error('ZIP exceeds safety limit');
        safeRelativePath(mainHtmlFileName);
        const zip = await JSZip.loadAsync(zipBuffer, { checkCRC32: false });
        const entries = Object.values(zip.files).filter(file => !file.dir && !file.name.startsWith('__MACOSX/') && !file.name.endsWith('.DS_Store'));
        if (entries.length > LIMITS.files) throw new Error('ZIP contains too many files');
        let predicted = 0;
        for (const file of entries) {
            safeRelativePath(file.unsafeOriginalName || file.name);
            predicted += file._data?.uncompressedSize || 0;
        }
        if (predicted > LIMITS.expandedBytes) throw new Error('ZIP expanded size exceeds safety limit');
        if (!zip.files[mainHtmlFileName] || !/\.html?$/i.test(mainHtmlFileName)) throw new Error('HTML entry point is missing');
        const token = crypto.randomBytes(24).toString('hex');
        const directory = path.join(root, token);
        await fs.mkdir(directory);
        let expanded = 0;
        try {
            for (const file of entries) {
                if (!MIME[path.extname(file.name).toLowerCase()]) continue;
                const content = await file.async('nodebuffer');
                expanded += content.length;
                if (expanded > LIMITS.expandedBytes) throw new Error('ZIP expanded size exceeds safety limit');
                const destination = path.join(directory, safeRelativePath(file.name));
                await fs.mkdir(path.dirname(destination), { recursive: true });
                await fs.writeFile(destination, content);
            }
            previews.set(token, { directory });
            return { token, url: `http://127.0.0.1:${port}/${token}/${mainHtmlFileName.split('/').map(encodeURIComponent).join('/')}` };
        } catch (error) {
            await fs.rm(directory, { recursive: true, force: true });
            throw error;
        }
    }
    async function releasePreview(token) {
        const preview = previews.get(token);
        if (!preview) return;
        previews.delete(token);
        await fs.rm(preview.directory, { recursive: true, force: true });
    }
    async function analyzeVideo({ buffer, filename }) {
        if (!buffer || buffer.byteLength > LIMITS.assetBytes) throw new Error('Video exceeds the 500 MB safety limit');
        const extension = path.extname(String(filename)).toLowerCase();
        if (!['.mp4', '.mov', '.webm', '.avi', '.mkv', '.m4v', '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.opus'].includes(extension)) throw new Error('Unsupported media extension');
        const directory = await fs.mkdtemp(path.join(root, 'video-'));
        const filePath = path.join(directory, `input${extension}`);
        const controller = new AbortController();
        controllers.add(controller);
        try {
            await fs.writeFile(filePath, Buffer.from(buffer));
            const options = { timeout: 120000, maxBuffer: 10 * 1024 * 1024, windowsHide: true, signal: controller.signal };
            const { stdout } = await execute(path.join(binaryDirectory, 'ffprobe.exe'), ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath], options);
            const probe = JSON.parse(stdout);
            const video = probe.streams?.find(stream => stream.codec_type === 'video');
            const audio = probe.streams?.find(stream => stream.codec_type === 'audio');
            const frameRate = (video?.avg_frame_rate || '0/1').split('/').map(Number);
            const metadata = { width: video?.width, height: video?.height, duration: finite(probe.format?.duration), videoCodec: video?.codec_name, audioCodec: audio?.codec_name, bitrate: finite(probe.format?.bit_rate), videoBitrate: finite(video?.bit_rate), audioBitrate: finite(audio?.bit_rate), frameRate: frameRate[1] ? frameRate[0] / frameRate[1] : null, sampleRate: finite(audio?.sample_rate), channels: audio?.channels };
            if (!audio) return { metadata, measurement: null, audioState: 'No audio track' };
            try {
                const { stderr } = await execute(path.join(binaryDirectory, 'ffmpeg.exe'), ['-nostdin', '-hide_banner', '-i', filePath, '-map', '0:a:0', '-af', 'loudnorm=print_format=json', '-f', 'null', '-'], options);
                const output = stderr.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/);
                if (!output) throw new Error('Loudness output could not be parsed');
                const measurement = JSON.parse(output[0]);
                return { metadata, measurement: { lufs: finite(measurement.input_i), truePeak: finite(measurement.input_tp), range: finite(measurement.input_lra) }, audioState: finite(measurement.input_i) === null ? 'Silent or unmeasurable audio' : 'Measured with FFmpeg loudnorm' };
            } catch (error) {
                if (controller.signal.aborted) throw error;
                return { metadata, measurement: null, audioState: 'Audio analysis failed', error: error.message };
            }
        } finally {
            controllers.delete(controller);
            await fs.rm(directory, { recursive: true, force: true });
        }
    }
    function cancelAnalyses() { for (const controller of controllers) controller.abort(); }
    async function close() {
        cancelAnalyses();
        if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
        if (root) await fs.rm(root, { recursive: true, force: true });
    }
    return { start, extractCreative, releasePreview, analyzeVideo, cancelAnalyses, close };
}

module.exports = { createBackend, safeRelativePath, finite };