import { createIcons, Moon, Sun, BookOpen, Download, ChevronDown, SlidersHorizontal, FolderUp, Plus, Play, Square, Trash2, Search, Files, ScanSearch, Image as ImageIcon, RotateCcw, Maximize, FileArchive, FileImage, Film, CheckCircle2, CircleAlert, CircleHelp, XCircle, Info, LoaderCircle } from 'lucide';
const JSZip = require('jszip');
const postcss = require('postcss');
const valueParser = require('postcss-value-parser');
const { jsPDF } = require('jspdf');
const { DEFAULTS, defaultsFor, STANDARD_SIZES, isTrustedHost, dimensionCheck, LIMITS, result, statusFor, resolveReference, checkVideo, profileForKind } = require('./qa-core');
const icons = { Moon, Sun, BookOpen, Download, ChevronDown, SlidersHorizontal, FolderUp, Plus, Play, Square, Trash2, Search, Files, ScanSearch, Image: ImageIcon, RotateCcw, Maximize, FileArchive, FileImage, Film, CheckCircle2, CircleAlert, CircleHelp, XCircle, Info, LoaderCircle };
const state = { items: [], selected: null, filter: 'all', running: false, cancelled: false, worker: null, dirty: false, preview: null, previewVersion: 0, actualSize: false };
const fields = [...document.querySelectorAll('#spec-settings input, #spec-settings select')].map(field => field.id);
const $ = id => document.getElementById(id);
const element = (tag, className = '', text = '') => { const node = document.createElement(tag); node.className = className; node.textContent = text; return node; };
const icon = name => { const node = element('i'); node.dataset.lucide = name; return node; };
const refreshIcons = () => createIcons({ icons });
const selected = () => state.items.find(item => item.id === state.selected);
const extension = name => name.split('.').pop().toLowerCase();
const nullable = id => $(id).value.trim() === '' ? null : Number($(id).value);
const fileKind = name => extension(name) === 'zip' ? 'html5' : ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(extension(name)) ? 'image' : ['mp4', 'mov', 'webm', 'avi', 'mkv', 'm4v'].includes(extension(name)) ? 'video' : ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus'].includes(extension(name)) ? 'audio' : 'unsupported';
const sizeText = size => size >= 1024 * 1024 ? `${(size / (1024 * 1024)).toFixed(2)} MB` : `${(size / 1024).toFixed(1)} KB`;
const displayStatus = item => item.status === 'review' && item.reviewed ? 'reviewed' : item.status;
const statusLabel = status => ({ pending: 'Queued', running: 'Checking', fail: 'Blocked', review: 'Review', pass: 'Passed', reviewed: 'Reviewed' }[status] || status);
const kindLabel = kind => ({ html5: 'HTML5', image: 'Display', video: 'Video', audio: 'Audio' }[kind] || 'Unknown');

const activeDefaults = () => $('use-defaults').checked ? defaultsFor($('display-profile').value) : { display: {}, image: {}, media: {} };

function readProfile() {
    const baseline = activeDefaults();
    const base = group => ({ reference: $(`${group}-reference`).value.trim(), version: '2026.10', duration: limit(group, 'duration', `${group}-duration`), width: nullable(`${group}-width`), height: nullable(`${group}-height`) });
    const defaulted = [];
    const limit = (group, key, id) => { const value = nullable(id); if (value !== null || baseline[group][key] === undefined) return value; defaulted.push(`${group}.${key}`); return baseline[group][key]; };
    const target = limit('media', 'loudness', 'loudness-target');
    const profiles = {
        display: { ...base('display'), id: $('display-profile').value, name: `HTML5 display / ${$('display-profile').selectedOptions[0].textContent}`, maxKB: limit('display', 'maxKB', 'display-size'), maxFiles: baseline.display.maxFiles ?? null },
        image: { ...base('image'), id: 'image', name: 'Images / JPG / GIF / PNG', maxKB: limit('image', 'maxKB', 'image-size'), border: $('image-border').checked },
        media: { ...base('media'), id: 'media', name: 'Video / audio', mediaMB: nullable('media-size'), videoBitrate: nullable('media-bitrate'), loudness: target, tolerance: nullable('loudness-tolerance') ?? (defaulted.includes('media.loudness') ? baseline.media.tolerance : 1), truePeak: nullable('true-peak'), videoCodec: $('video-codec').value, audioCodec: $('audio-codec').value, frameRate: nullable('frame-rate'), channels: nullable('audio-channels') }
    };
    for (const group of Object.keys(profiles)) profiles[group].defaulted = defaulted.filter(key => key.startsWith(`${group}.`)).map(key => key.split('.')[1]).join(', ');
    for (const group of Object.keys(profiles)) profiles[group].baseline = $('use-defaults').checked;
    return profiles;
}

function refreshPlaceholders() {
    const baseline = activeDefaults();
    for (const [id, group, key] of [['display-size', 'display', 'maxKB'], ['display-duration', 'display', 'duration'], ['image-size', 'image', 'maxKB'], ['image-duration', 'image', 'duration'], ['loudness-target', 'media', 'loudness']]) $(id).placeholder = baseline[group][key] === undefined ? 'Not set' : `Default ${baseline[group][key]}`;
}

function badge(item) {
    const status = displayStatus(item);
    return element('span', `badge ${status}`, statusLabel(status));
}

function setStatus(message) { $('run-status').textContent = message; }

function releasePreview() {
    state.previewVersion++;
    if (state.preview) {
        clearInterval(state.preview.timer);
        state.preview.observer?.disconnect();
        window.electronAPI?.releasePreview(state.preview.token).catch(() => {});
    }
    state.preview = null;
    $('preview-stage').replaceChildren();
    $('preview-timer').textContent = '0.0s';
}

function addFiles(files) {
    if (state.running) return;
    let added = 0;
    for (const file of files) {
        if (state.items.some(item => item.file === file)) continue;
        state.items.push({ id: crypto.randomUUID(), file, kind: fileKind(file.name), status: 'pending', checks: [], metadata: {}, events: [], reviewed: false });
        added++;
    }
    if (!state.selected && state.items.length) state.selected = state.items[0].id;
    setStatus(`${added} asset${added === 1 ? '' : 's'} added`);
    $('allFiles').value = '';
    render();
}

function removeItem(id) {
    if (state.running) return;
    const item = state.items.find(entry => entry.id === id);
    if (state.selected === id) releasePreview();
    if (item?.objectURL) URL.revokeObjectURL(item.objectURL);
    state.items = state.items.filter(entry => entry.id !== id);
    if (state.selected === id) state.selected = state.items[0]?.id || null;
    render();
}

function visibleItems() {
    const query = $('search').value.toLowerCase();
    const items = state.items.filter(item => {
        const status = displayStatus(item);
        return (state.filter === 'all' || status === state.filter || (state.filter === 'ready' && ['pass', 'reviewed'].includes(status))) && ($('type-filter').value === 'all' || item.kind === $('type-filter').value) && item.file.name.toLowerCase().includes(query);
    });
    if ($('sort-order').value === 'type') items.sort((first, second) => first.kind.localeCompare(second.kind) || first.file.name.localeCompare(second.file.name));
    if ($('sort-order').value === 'name') items.sort((first, second) => first.file.name.localeCompare(second.file.name));
    return items;
}

function renderQueue() {
    const items = visibleItems();
    $('asset-rows').replaceChildren();
    for (const item of items) {
        const row = element('tr', item.id === state.selected ? 'selected' : '');
        const nameCell = element('td');
        const name = element('button', 'asset-name');
        name.setAttribute('aria-label', `Inspect ${item.file.name}`);
        name.setAttribute('aria-pressed', String(item.id === state.selected));
        const title = element('span');
        title.append(element('strong', '', item.file.name), element('small', '', `${item.kind === 'html5' ? 'HTML5' : extension(item.file.name).toUpperCase()} / ${sizeText(item.file.size)}`));
        name.append(icon(item.kind === 'html5' ? 'file-archive' : ['video', 'audio'].includes(item.kind) ? 'film' : 'file-image'), title);
        name.onclick = () => { if (state.selected !== item.id) { releasePreview(); state.selected = item.id; } render(); };
        nameCell.append(name);
        const dimensions = element('td', '', item.metadata.width && item.metadata.height ? `${item.metadata.width} x ${item.metadata.height}` : '-');
        const statusCell = element('td'); statusCell.append(badge(item));
        const removeCell = element('td'); const remove = element('button', 'icon-button');
        remove.title = `Remove ${item.file.name}`; remove.setAttribute('aria-label', remove.title); remove.disabled = state.running; remove.append(icon('trash-2')); remove.onclick = () => removeItem(item.id); removeCell.append(remove);
        row.append(nameCell, dimensions, statusCell, removeCell); $('asset-rows').append(row);
    }
    $('visible-count').textContent = `${items.length} of ${state.items.length}`;
    $('queue-empty').hidden = items.length > 0;
    $('queue-empty').querySelector('h3').textContent = state.items.length ? 'No matching assets' : 'No assets yet';
    $('empty-detail').textContent = state.items.length ? '0 assets match these filters' : '0 creatives in this batch';
    $('total-count').textContent = state.items.length;
    $('failed-count').textContent = state.items.filter(item => item.status === 'fail').length;
    $('review-count').textContent = state.items.filter(item => item.status === 'review' && !item.reviewed).length;
    $('passed-count').textContent = state.items.filter(item => ['pass', 'reviewed'].includes(displayStatus(item))).length;
    $('batch-count').textContent = `${state.items.length} file${state.items.length === 1 ? '' : 's'}`;
    $('run-all').disabled = state.running || !state.items.length;
    $('allFiles').disabled = state.running;
    $('clear-all').disabled = state.running || !state.items.length;
    $('cancel-run').hidden = !state.running;
    for (const field of fields) $(field).disabled = state.running;
    const exportable = !state.running && !state.dirty && state.items.length > 0 && state.items.every(item => item.profile);
    for (const id of ['export-pdf', 'export-json']) $(id).disabled = !exportable;
}

function checkNode(check) {
    const node = element('div', 'check'); node.dataset.status = check.status;
    node.append(icon({ pass: 'check-circle-2', fail: 'x-circle', warning: 'circle-alert', note: 'info', unverified: 'circle-help' }[check.status] || 'circle-help'));
    const copy = element('div'); copy.append(element('strong', '', check.label), element('p', '', check.detail));
    if (check.fix && check.status !== 'pass') copy.append(element('p', 'fix', check.fix));
    node.append(copy); return node;
}

function renderInspector() {
    const item = selected();
    $('inspector-name').textContent = item?.file.name || 'No creative selected';
    $('inspector-badge').replaceChildren(); if (item) $('inspector-badge').append(badge(item));
    $('metadata').replaceChildren(); $('checks').replaceChildren();
    $('asset-settings').hidden = !item;
    for (const key of ['width', 'height', 'duration']) { $(`asset-${key}`).value = item?.overrides?.[key] ?? ''; $(`asset-${key}`).disabled = state.running; }
    $('asset-width-field').hidden = item?.kind === 'audio'; $('asset-height-field').hidden = item?.kind === 'audio';
    const entries = item ? [['Format', extension(item.file.name).toUpperCase()], ['File size', sizeText(item.file.size)], ['Dimensions', item.metadata.width ? `${item.metadata.width} x ${item.metadata.height}` : '-'], ['Specification', item.profile?.reference || item.profile?.name || 'Not checked']] : [];
    if (item?.metadata.duration !== undefined && item.metadata.duration !== null) entries.push(['Duration', `${Number(item.metadata.duration).toFixed(2)}s`]);
    for (const key of ['videoCodec', 'audioCodec', 'frameRate', 'sampleRate', 'channels']) if (item?.metadata[key] !== undefined && item.metadata[key] !== null) entries.push([{ videoCodec: 'Video codec', audioCodec: 'Audio codec', frameRate: 'Frame rate (fps)', sampleRate: 'Sample rate (Hz)', channels: 'Audio channels' }[key], String(item.metadata[key])]);
    if (item?.metadata.videoBitrate) entries.push(['Video bitrate', `${(item.metadata.videoBitrate / 1000000).toFixed(2)} Mbps`]);
    if (item?.metadata.audioBitrate) entries.push(['Audio bitrate', `${(item.metadata.audioBitrate / 1000).toFixed(0)} kbps`]);
    if (Number.isFinite(item?.measurement?.lufs)) entries.push(['Measured loudness', `${item.measurement.lufs.toFixed(1)} LUFS`]);
    if (Number.isFinite(item?.measurement?.truePeak)) entries.push(['Measured true peak', `${item.measurement.truePeak.toFixed(1)} dBTP`]);
    for (const [label, value] of entries) { const cell = element('div', 'meta-cell'); cell.append(element('span', '', label), element('strong', '', value)); $('metadata').append(cell); }
    $('check-count').textContent = item?.checks.length || 0;
    if (!item?.checks.length) { const empty = element('div', 'inspector-empty'); empty.append(icon(item?.status === 'running' ? 'loader-circle' : 'scan-search'), element('p', '', item?.status === 'running' ? 'Checking creative' : 'No results to display')); $('checks').append(empty); }
    else {
        if (item.status === 'pass' && item.checks.some(check => check.status === 'note')) $('checks').append(element('div', 'review-bar', 'Passed the main checks. The notes below may matter if the ad server does not accept this creative.'));
        for (const check of item.checks.filter(check => check.status !== 'pass')) $('checks').append(checkNode(check));
        const passes = item.checks.filter(check => check.status === 'pass');
        if (passes.length) { const details = element('details', 'passed-checks'); details.append(element('summary', '', `Passed checks (${passes.length})`)); for (const check of passes) details.append(checkNode(check)); $('checks').append(details); }
    }
    $('manual-review').hidden = !item?.profile;
    $('review-confirmed').checked = !!item?.reviewed;
    $('review-confirmed').disabled = state.running || item?.status === 'pending';
    $('review-stamp').textContent = item?.reviewed ? `Completed / ${new Date(item.reviewedAt).toLocaleString()}` : '';
    renderEvents();
    if (!state.preview && !$('preview-panel').hidden) renderPreviewPlaceholder();
}

function render() { renderQueue(); renderInspector(); refreshIcons(); }

function workerCheck(data) {
    return new Promise((resolve, reject) => {
        const worker = new Worker('assets/qa-worker.bundle.js');
        const finish = (value, error) => { clearTimeout(timer); worker.terminate(); state.worker = null; error ? reject(error) : resolve(value); };
        const timer = setTimeout(() => finish(null, new Error('Background check timed out')), 30000);
        state.worker = { cancel: () => finish(null, new Error('Cancelled')) };
        worker.onmessage = event => finish(event.data.value, event.data.error ? new Error(event.data.error) : null);
        worker.onerror = event => finish(null, new Error(event.message || 'Background worker failed'));
        worker.postMessage(data);
    });
}

function sizeCheck(item, profile, bytes = item.file.size) {
    const maximum = ['video', 'audio'].includes(item.kind) ? (profile.mediaMB ? profile.mediaMB * 1024 * 1024 : null) : (profile.maxKB ? profile.maxKB * 1024 : null);
    return result(item.kind === 'html5' ? 'Expanded ZIP size' : 'Asset size', maximum ? (bytes <= maximum ? 'pass' : 'fail') : 'unverified', `${sizeText(bytes)}${maximum ? `; ${profile.defaulted?.includes(profile.group === 'media' ? 'mediaMB' : 'maxKB') ? 'default' : 'selected'} maximum ${sizeText(maximum)}.` : '; no delivery limit selected.'}`, maximum ? 'Optimise assets if the selected limit is exceeded.' : 'Set the limit from the destination specification.');
}



async function processZip(item, profile, buffer) {
    const zip = await JSZip.loadAsync(buffer);
    const names = Object.keys(zip.files).filter(name => !zip.files[name].dir && !name.startsWith('__MACOSX/') && !name.endsWith('.DS_Store'));
    if (names.length > LIMITS.files) throw new Error('ZIP contains more than 1000 files');
    let expanded = 0;
    for (const name of names) {
        const original = zip.files[name].unsafeOriginalName || name;
        if (/(?:^|\/)\.\.(?:\/|$)/.test(original) || /[\\:\0]/.test(original) || original.startsWith('/')) throw new Error('Unsafe archive path');
        expanded += zip.files[name]._data?.uncompressedSize || 0;
    }
    if (expanded > LIMITS.expandedBytes) throw new Error('Expanded ZIP exceeds the 50 MB safety limit');
    item.checks.push(sizeCheck(item, profile, expanded), result('File count', profile.maxFiles && names.length > profile.maxFiles ? 'fail' : 'pass', `${names.length} asset files${profile.maxFiles ? `; maximum ${profile.maxFiles}` : ''}.`));
    const htmlFiles = names.filter(name => /\.html?$/i.test(name));
    if (htmlFiles.length !== 1) throw new Error(`Expected one HTML entry point; found ${htmlFiles.length}`);
    item.mainHtml = htmlFiles[0];
    const html = await zip.files[item.mainHtml].async('string');
    const documentHTML = new DOMParser().parseFromString(html, 'text/html');
    const sizeMeta = documentHTML.querySelector('meta[name="ad.size"]')?.getAttribute('content') || '';
    const width = Number(sizeMeta.match(/width\s*=\s*(\d+)/i)?.[1]);
    const height = Number(sizeMeta.match(/height\s*=\s*(\d+)/i)?.[1]);
    item.metadata = { width: width || parseInt(documentHTML.body.style.width) || null, height: height || parseInt(documentHTML.body.style.height) || null, expandedBytes: expanded };
    item.checks.push(dimensionCheck(item.metadata, profile));
    if (!width || !height) item.checks.push(result('Ad size metadata', ['cm360', 'dv360'].includes(profile.id) ? 'fail' : 'warning', 'A valid ad.size metadata declaration was not found.', 'Add a meta name="ad.size" tag with width and height.'));
    const charset = documentHTML.querySelector('meta[charset]')?.getAttribute('charset');
    item.checks.push(result('Character encoding', charset?.toLowerCase() === 'utf-8' ? 'pass' : 'warning', charset?.toLowerCase() === 'utf-8' ? 'UTF-8 declared.' : 'UTF-8 declaration not found.'));
    const scripts = [];
    const styles = [];
    const references = [];
    const domains = new Set();
    const externalScripts = new Set();
    for (const node of documentHTML.querySelectorAll('[src],[href],[data],[poster]')) {
        for (const attribute of ['src', 'href', 'data', 'poster']) {
            if (!node.hasAttribute(attribute)) continue;
            if (node.tagName === 'A' && attribute === 'href') continue;
            references.push({ owner: item.mainHtml, reference: node.getAttribute(attribute) });
        }
    }
    for (const node of documentHTML.querySelectorAll('script')) {
        if (node.src) { if (/^(https?:)?\/\//i.test(node.getAttribute('src'))) externalScripts.add(node.getAttribute('src')); }
        else if (!node.type || /^(?:module|text\/javascript|application\/javascript)$/i.test(node.type)) scripts.push({ name: item.mainHtml, content: node.textContent, module: node.type === 'module' });
    }
    for (const node of documentHTML.querySelectorAll('*')) for (const attribute of node.attributes) if (/^on/i.test(attribute.name)) scripts.push({ name: `${item.mainHtml}:${attribute.name}`, content: `function handler(event){${attribute.value}}` });
    for (const node of documentHTML.querySelectorAll('a[href],area[href]')) { const href = node.getAttribute('href').trim(); if (/^javascript:/i.test(href)) scripts.push({ name: `${item.mainHtml}:href`, content: `function handler(){${href.slice(11)}}` }); }
    for (const node of documentHTML.querySelectorAll('style')) styles.push({ name: item.mainHtml, content: node.textContent });
    for (const node of documentHTML.querySelectorAll('[style]')) styles.push({ name: item.mainHtml, content: `.inline {${node.getAttribute('style')}}` });
    for (const name of names) {
        if (/\.js$/i.test(name)) {
            const isModule = [...documentHTML.querySelectorAll('script[type="module"][src]')].some(script => { try { return resolveReference(item.mainHtml, script.getAttribute('src')) === name; } catch (_) { return false; } });
            scripts.push({ name, content: await zip.files[name].async('string'), module: isModule });
        }
        if (/\.css$/i.test(name)) styles.push({ name, content: await zip.files[name].async('string') });
    }
    for (const stylesheet of styles) {
        try {
            const tree = postcss.parse(stylesheet.content);
            tree.walkDecls(declaration => valueParser(declaration.value).walk(node => { if (node.type === 'function' && node.value.toLowerCase() === 'url') references.push({ owner: stylesheet.name, reference: valueParser.stringify(node.nodes).replace(/^['"]|['"]$/g, '') }); }));
            tree.walkAtRules('import', rule => { const value = valueParser(rule.params).nodes[0]; if (value?.type === 'string') references.push({ owner: stylesheet.name, reference: value.value }); });
        } catch (_) { item.checks.push(result('CSS parsing', 'unverified', `${stylesheet.name} could not be parsed.`)); }
    }
    const missing = new Set();
    const insecure = new Set();
    for (const entry of references) {
        try {
            const resolved = resolveReference(entry.owner, entry.reference);
            if (resolved && !names.includes(resolved)) missing.add(`${entry.owner} -> ${entry.reference}`);
            if (/^http:\/\//i.test(entry.reference)) insecure.add(entry.reference);
            if (/^(https?:)?\/\//i.test(entry.reference)) domains.add(new URL(entry.reference, 'https://preview.invalid').hostname);
        } catch (error) { missing.add(`${entry.owner} -> ${entry.reference}: ${error.message}`); }
    }
    item.checks.push(result('Local dependencies', missing.size ? 'fail' : 'pass', missing.size ? [...missing].join('; ') : 'Parsed HTML and CSS references resolve within the ZIP.', 'Correct paths and include the referenced files; file names are case-sensitive.'));
    item.checks.push(result('HTTPS resources', insecure.size ? 'fail' : 'pass', insecure.size ? [...insecure].join('; ') : 'No HTTP resources found in parsed HTML and CSS.'));
    const foreignDomains = [...domains].filter(host => !isTrustedHost(host));
    const foreignScripts = [...externalScripts].filter(source => { try { return !isTrustedHost(new URL(source, 'https://preview.invalid').hostname); } catch (_) { return true; } });
    if (domains.size) item.checks.push(result('External resources', foreignDomains.length ? 'note' : 'pass', foreignDomains.length ? `${foreignDomains.join(', ')}. Confirm destination policy, availability, and network behaviour.` : `Google-hosted only: ${[...domains].join(', ')}.`));
    if (externalScripts.size) item.checks.push(result('Remote JavaScript', foreignScripts.length ? 'note' : 'pass', foreignScripts.length ? `${foreignScripts.join(', ')} is not fetched or approved by static analysis.` : 'Scripts load from Google-hosted runtime libraries.'));
    item.checks.push(...await workerCheck({ type: 'scripts', scripts, styles, mode: profile.id === 'studio' ? 'studio' : profile.id === 'auto' ? 'auto' : 'display', duration: profile.duration, incomplete: foreignScripts.length > 0, trustedRuntime: externalScripts.size > foreignScripts.length }));
}

async function imageDimensions(url) {
    return new Promise((resolve, reject) => {
        const image = new window.Image();
        const timer = setTimeout(() => reject(new Error('Image decoding timed out')), 15000);
        image.onload = () => { clearTimeout(timer); resolve({ width: image.naturalWidth, height: image.naturalHeight }); };
        image.onerror = () => { clearTimeout(timer); reject(new Error('Image could not be decoded')); };
        image.src = url;
    });
}

async function videoMetadata(url, kind = 'video') {
    return new Promise((resolve, reject) => {
        const video = document.createElement(kind === 'audio' ? 'audio' : 'video'); video.preload = 'metadata';
        const finish = () => { video.removeAttribute('src'); video.load(); };
        const timer = setTimeout(() => { finish(); reject(new Error('Browser video decoding timed out')); }, 15000);
        video.onloadedmetadata = () => { clearTimeout(timer); resolve({ width: video.videoWidth, height: video.videoHeight, duration: video.duration }); finish(); };
        video.onerror = () => { clearTimeout(timer); finish(); reject(new Error('Video format is not supported by browser playback')); };
        video.src = url;
    });
}

async function processFile(item, profile) {
    item.checks = []; item.metadata = {}; item.measurement = null; item.events = []; item.reviewed = false; item.reviewedAt = null; item.profile = null;
    if (item.file.size > LIMITS.assetBytes || (item.kind === 'html5' && item.file.size > LIMITS.expandedBytes)) throw new Error('Asset exceeds the safety size limit');
    if (item.kind === 'unsupported') throw new Error('Unsupported file extension');
    const buffer = await item.file.arrayBuffer();
    if (state.cancelled) throw new Error('Cancelled');
    item.hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (item.kind === 'html5') await processZip(item, profile, buffer);
    else {
        if (!item.objectURL) item.objectURL = URL.createObjectURL(item.file);
        item.checks.push(sizeCheck(item, profile));
        if (item.kind === 'image') {
            if (extension(item.file.name) === 'gif') {
                const gif = await workerCheck({ type: 'gif', buffer });
                if (gif.animated) item.checks.push(result('GIF playback', profile.duration ? (gif.duration <= profile.duration ? 'pass' : 'fail') : 'unverified', `${gif.frames} frames; ${gif.duration === Infinity ? 'infinite playback' : `${gif.duration.toFixed(2)}s including repetitions`}.`));
            }
            item.metadata = await imageDimensions(item.objectURL);
            if (item.metadata.width * item.metadata.height > 25000000) throw new Error('Image exceeds the 25 megapixel safety limit');
            item.checks.push(result('Image decoding', 'pass', 'Image decoded successfully.'), dimensionCheck(item.metadata, profile, true));
            if (['cm360', 'dv360'].includes(profile.id) && ['svg', 'webp'].includes(extension(item.file.name))) item.checks.push(result('Hosted image format', 'warning', 'Verify SVG/WebP acceptance for this destination; use the required raster format.'));
            item.checks.push(result(profile.border ? 'Required border' : 'Visual inspection', 'unverified', profile.border ? 'A border is required by the selected spec. Inspect the original pixels at actual size.' : 'Check legibility, CTA, safe areas, and final appearance against the brief.'));
        } else {
            if (window.electronAPI) {
                try {
                    const analysis = await window.electronAPI.analyzeVideo(buffer, item.file.name);
                    item.metadata = analysis.metadata; item.measurement = analysis.measurement;
                    item.checks.push(result('Audio analysis', analysis.error ? 'unverified' : 'pass', analysis.audioState));
                    if (analysis.error) item.checks.push(result('Audio analysis error', 'unverified', analysis.error));
                } catch (error) {
                    if (state.cancelled) throw error;
                    item.checks.push(result('Native analysis', 'unverified', error.message));
                    item.metadata = await videoMetadata(item.objectURL, item.kind);
                }
            } else {
                item.metadata = await videoMetadata(item.objectURL, item.kind);
                item.checks.push(result('Native metadata / loudness', 'unverified', 'FFmpeg analysis is available in the desktop application.'));
            }
            item.checks.push(...checkVideo(item.metadata, item.measurement, profile));
        }
    }
    if (state.cancelled) throw new Error('Cancelled');
    item.profile = structuredClone(profile); item.checkedAt = new Date().toISOString(); item.status = statusFor(item.checks);
}

async function runBatch() {
    if (state.running || !state.items.length) return;
    const groups = new Set(state.items.map(item => profileForKind({}, item.kind).group));
    const relevantFields = fields.filter(id => groups.has($(id).closest('[data-group]').dataset.group));
    const invalid = relevantFields.find(id => !$(id).checkValidity());
    if (invalid) { $(invalid).reportValidity(); return; }
    const profiles = readProfile();
    for (const item of state.items) {
        const profile = profileForKind(profiles, item.kind, item.overrides);
        if (!!profile.width !== !!profile.height) { setStatus(`Set both width and height, or leave both empty: ${item.file.name}`); return; }
    }
    releasePreview(); state.running = true; state.cancelled = false; state.dirty = false;
    for (const item of state.items) { item.status = 'pending'; item.profile = null; item.checks = []; item.reviewed = false; }
    $('batch-progress').hidden = false; $('batch-progress').max = state.items.length; $('batch-progress').value = 0;
    let completed = 0;
    for (const item of state.items) {
        if (state.cancelled) break;
        const profile = profileForKind(profiles, item.kind, item.overrides);
        item.status = 'running'; setStatus(`Checking ${completed + 1} of ${state.items.length}: ${item.file.name}`); render();
        try { await processFile(item, profile); }
        catch (error) {
            if (state.cancelled) { item.status = 'pending'; item.profile = null; item.checks = []; break; }
            item.checks.push(result('Processing', 'fail', error.message, 'Check the source file and packaging. Other files in the batch will continue.'));
            item.profile = structuredClone(profile); item.checkedAt = new Date().toISOString(); item.status = 'fail';
        }
        completed++; $('batch-progress').value = completed; render();
        await new Promise(resolve => requestAnimationFrame(resolve));
    }
    state.running = false; $('batch-progress').hidden = true;
    setStatus(state.cancelled ? `Cancelled. ${completed} of ${state.items.length} assets checked.` : `Preflight complete. ${completed} assets checked.`);
    render();
}

let toastTimer;
function showExitToast(url) {
    document.querySelector('.exit-toast')?.remove(); clearTimeout(toastTimer);
    const toast = element('div', 'exit-toast'); toast.setAttribute('role', 'status');
    toast.append(element('strong', '', 'Click captured'), element('span', '', url && url !== 'undefined' ? url : 'No URL supplied (clickTag is empty in the preview)'));
    document.body.append(toast); toastTimer = setTimeout(() => toast.remove(), 4000);
}

function renderEvents() {
    const events = selected()?.events || [];
    $('runtime-count').textContent = `${events.length} event${events.length === 1 ? '' : 's'}`;
    $('runtime-events').replaceChildren();
    for (const event of events.slice(-50)) { const node = element('li', '', `${event.elapsed.toFixed(1)}s / ${event.kind.toUpperCase()} / ${event.detail}`); node.dataset.kind = event.kind; $('runtime-events').append(node); }
}

function renderPreviewPlaceholder() {
    const item = selected(); const stage = $('preview-stage'); stage.replaceChildren();
    const empty = element('div', 'inspector-empty');
    if (!item) { empty.append(icon('image'), element('p', '', 'No preview selected')); stage.append(empty); }
    else if (item.kind === 'html5') {
        if (!window.electronAPI) empty.append(icon('file-archive'), element('p', '', 'HTML5 preview requires the desktop application'));
        else if (!item.mainHtml || !item.metadata.width || !item.metadata.height) empty.append(icon('circle-help'), element('p', '', 'HTML entry point and dimensions required'));
        else { const load = element('button', 'button secondary', 'Load preview'); load.prepend(icon('play')); load.onclick = () => loadHTMLPreview(item); empty.append(load); }
        stage.append(empty);
    } else if (item.objectURL) {
        const media = element(item.kind === 'audio' ? 'audio' : item.kind === 'video' ? 'video' : 'img');
        media.src = item.objectURL;
        if (['video', 'audio'].includes(item.kind)) { media.controls = true; media.preload = 'metadata'; } else media.alt = item.file.name;
        stage.append(media);
    } else { empty.append(icon('image'), element('p', '', 'Preflight not yet run')); stage.append(empty); }
    refreshIcons();
}

async function loadHTMLPreview(item) {
    releasePreview();
    const version = state.previewVersion;
    if (item.metadata.width > 8192 || item.metadata.height > 8192 || item.metadata.width * item.metadata.height > 25000000) { setStatus('Preview dimensions exceed the safety limit.'); return; }
    $('preview-stage').replaceChildren(element('div', 'inspector-empty', 'Preparing preview'));
    let preview;
    try {
        preview = await window.electronAPI.extractCreative({ zipBuffer: await item.file.arrayBuffer(), mainHtmlFileName: item.mainHtml });
        if (version !== state.previewVersion || selected()?.id !== item.id) { await window.electronAPI.releasePreview(preview.token); return; }
        const frame = element('iframe'); frame.title = `Preview of ${item.file.name}`; frame.setAttribute('sandbox', 'allow-scripts'); frame.setAttribute('referrerpolicy', 'no-referrer');
        frame.width = item.metadata.width; frame.height = item.metadata.height; frame.setAttribute('scrolling', 'no');
        const canvas = element('div', 'preview-canvas'); canvas.append(frame); $('preview-stage').replaceChildren(canvas);
        const started = performance.now();
        const fit = () => { const stage = $('preview-stage'); const scale = state.actualSize ? 1 : Math.min(1, (stage.clientWidth - 32) / item.metadata.width, (stage.clientHeight - 32) / item.metadata.height); canvas.style.width = `${item.metadata.width * scale}px`; canvas.style.height = `${item.metadata.height * scale}px`; frame.style.transform = `scale(${scale})`; };
        const observer = new ResizeObserver(fit); observer.observe($('preview-stage'));
        state.preview = { ...preview, frame, started, observer, fit, timer: setInterval(() => { $('preview-timer').textContent = `${((performance.now() - started) / 1000).toFixed(1)}s`; }, 100) };
        frame.src = preview.url; fit();
    } catch (error) { if (preview) window.electronAPI.releasePreview(preview.token).catch(() => {}); if (version === state.previewVersion) $('preview-stage').replaceChildren(element('div', 'inspector-empty', error.message)); }
}

function selectTab(name) {
    const preview = name === 'preview';
    $('checks-panel').hidden = preview; $('preview-panel').hidden = !preview;
    $('checks-tab').setAttribute('aria-selected', String(!preview)); $('preview-tab').setAttribute('aria-selected', String(preview));
    $('checks-tab').tabIndex = preview ? -1 : 0; $('preview-tab').tabIndex = preview ? 0 : -1;
    if (preview && !state.preview) renderPreviewPlaceholder();
    if (!preview) releasePreview();
    refreshIcons();
}

function download(filename, blob) {
    const url = URL.createObjectURL(blob); const link = element('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const PDF_COLOURS = { pass: [19, 123, 85], fail: [182, 56, 59], review: [160, 100, 8], note: [90, 98, 112], ink: [34, 38, 44], muted: [99, 106, 117], line: [220, 224, 229], band: [245, 246, 248] };
const LIMIT_LABELS = { maxKB: 'Max size (KB)', maxFiles: 'Max files', mediaMB: 'Max size (MB)', duration: 'Max duration (s)', width: 'Width (px)', height: 'Height (px)', videoBitrate: 'Max video bitrate (Mbps)', loudness: 'Loudness (LUFS)', tolerance: 'Loudness tolerance (LU)', truePeak: 'Max true peak (dBTP)', videoCodec: 'Video codec', audioCodec: 'Audio codec', frameRate: 'Frame rate (fps)', channels: 'Audio channels' };

function exportPDF() {
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const margin = 15, width = 180, bottom = 280;
    let y = margin;
    const safe = value => String(value).replace(/[^\x20-\x7e\xa0-\xff\n]/g, '?');
    const colour = name => doc.setTextColor(...PDF_COLOURS[name]);
    const ensure = height => { if (y + height > bottom) { doc.addPage(); y = margin; } };
    const write = (text, { x = margin, size = 9, bold = false, tone = 'ink', maxWidth = width, gap = 1.2, font = 'helvetica' } = {}) => {
        doc.setFont(font, bold ? 'bold' : 'normal'); doc.setFontSize(size); colour(tone);
        const lineHeight = size * 0.42;
        for (const wrapped of doc.splitTextToSize(safe(text), maxWidth)) { ensure(lineHeight); doc.text(wrapped, x, y + lineHeight * 0.8); y += lineHeight; }
        y += gap;
    };
    const rule = () => { doc.setDrawColor(...PDF_COLOURS.line); doc.line(margin, y, margin + width, y); y += 3; };
    const toneFor = status => status === 'fail' ? 'fail' : status === 'pass' ? 'pass' : status === 'note' ? 'note' : 'review';
    const checkLabel = status => ({ fail: 'FAIL', pass: 'PASS', note: 'NOTE', warning: 'REVIEW', unverified: 'REVIEW' }[status] || 'REVIEW');
    const pill = (text, tone, x, top) => { doc.setFillColor(...PDF_COLOURS[tone]); doc.roundedRect(x, top, 24, 6, 1.5, 1.5, 'F'); doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(255, 255, 255); doc.text(text, x + 12, top + 4.2, { align: 'center' }); };
    const items = state.items.filter(item => item.profile);
    const counts = { pass: items.filter(item => ['pass', 'reviewed'].includes(displayStatus(item))).length, review: items.filter(item => item.status === 'review' && !item.reviewed).length, fail: items.filter(item => item.status === 'fail').length };

    write("Sunshine's Creative QA", { size: 18, bold: true, gap: 1 });
    write('Batch report', { size: 11, tone: 'muted', gap: 1 });
    write(`Generated ${new Date().toLocaleString()}  |  Rules ${items[0]?.profile.version || ''}  |  Local preflight and recorded review; not platform approval.`, { size: 8, tone: 'muted', gap: 5 });

    const boxWidth = width / 4 - 3;
    ensure(22);
    [['Assets', items.length, 'ink'], ['Passed', counts.pass, 'pass'], ['Review', counts.review, 'review'], ['Blocked', counts.fail, 'fail']].forEach(([label, value, tone], index) => {
        const x = margin + index * (boxWidth + 4);
        doc.setFillColor(...PDF_COLOURS.band); doc.roundedRect(x, y, boxWidth, 18, 2, 2, 'F');
        doc.setFont('helvetica', 'bold'); doc.setFontSize(18); colour(tone); doc.text(String(value), x + 5, y + 10.5);
        doc.setFontSize(8); doc.setFont('helvetica', 'normal'); colour('muted'); doc.text(label.toUpperCase(), x + 5, y + 15.5);
    });
    y += 24;

    write('Summary', { size: 12, bold: true, gap: 2 });
    const columns = [['File', margin, 84], ['Type', margin + 86, 22], ['Size', margin + 110, 26], ['Status', margin + 138, 42]];
    ensure(8); doc.setFillColor(...PDF_COLOURS.band); doc.rect(margin, y, width, 6.5, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8); colour('muted');
    for (const [label, x] of columns) doc.text(label.toUpperCase(), x + 1.5, y + 4.4);
    y += 7.5;
    for (const item of items) {
        ensure(7);
        const status = displayStatus(item);
        const tone = status === 'fail' ? 'fail' : status === 'pass' || status === 'reviewed' ? 'pass' : 'review';
        const issues = item.checks.filter(check => check.status === 'fail').length;
        const nameLines = doc.splitTextToSize(safe(item.file.name), 82);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); colour('ink');
        doc.text(nameLines, margin + 1.5, y + 3.6);
        doc.text(kindLabel(item.kind), margin + 87.5, y + 3.6);
        doc.text(item.kind === 'audio' ? 'Audio' : item.metadata.width ? `${item.metadata.width} x ${item.metadata.height}` : '-', margin + 111.5, y + 3.6);
        doc.setFont('helvetica', 'bold'); colour(tone); doc.text(`${statusLabel(status)}${issues ? ` (${issues} blocker${issues > 1 ? 's' : ''})` : ''}`, margin + 139.5, y + 3.6);
        y += 3.6 * nameLines.length + 2.4; doc.setDrawColor(...PDF_COLOURS.line); doc.line(margin, y, margin + width, y); y += 1;
    }

    for (const item of items) {
        doc.addPage(); y = margin;
        const status = displayStatus(item);
        const tone = status === 'fail' ? 'fail' : status === 'pass' || status === 'reviewed' ? 'pass' : 'review';
        pill(statusLabel(status).toUpperCase(), tone, margin + width - 24, y);
        write(item.file.name, { size: 13, bold: true, maxWidth: width - 30, gap: 1 });
        const facts = [kindLabel(item.kind), item.kind === 'audio' ? null : item.metadata.width ? `${item.metadata.width} x ${item.metadata.height}` : null, sizeText(item.file.size), Number.isFinite(item.metadata.duration) ? `${Number(item.metadata.duration).toFixed(1)} s` : null].filter(Boolean);
        write(facts.join('  |  '), { size: 9, tone: 'muted', gap: 1 });
        write(`Checked ${new Date(item.checkedAt).toLocaleString()}  |  Manual review: ${item.reviewed ? `confirmed ${new Date(item.reviewedAt).toLocaleString()}` : 'pending'}`, { size: 8, tone: 'muted', gap: 3 });
        rule();

        write('Specification', { size: 10, bold: true, gap: 1 });
        write(item.profile.reference || item.profile.name, { size: 9, gap: 1 });
        const limits = Object.entries(LIMIT_LABELS).filter(([key]) => item.profile[key] !== null && item.profile[key] !== undefined && item.profile[key] !== '').map(([key, label]) => `${label}: ${item.profile[key]}`);
        if (item.profile.border) limits.push('Border required');
        write(limits.length ? limits.join('   |   ') : 'No limits applied.', { size: 8.5, tone: 'muted', gap: 1 });
        if (item.profile.defaulted) write(`Baseline values used for: ${item.profile.defaulted.split(', ').map(key => LIMIT_LABELS[key] || key).join(', ')}.`, { size: 8, tone: 'muted', gap: 1 });
        y += 2; rule();

        const order = { fail: 0, warning: 1, unverified: 1, note: 2, pass: 3 };
        const sorted = [...item.checks].sort((a, b) => (order[a.status] ?? 1) - (order[b.status] ?? 1));
        write(`Checks (${item.checks.length})`, { size: 10, bold: true, gap: 2 });
        for (const check of sorted) {
            const compact = check.status === 'pass';
            ensure(compact ? 6 : 12);
            doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); colour(toneFor(check.status)); doc.text(checkLabel(check.status), margin, y + 3);
            const top = y;
            write(check.label, { x: margin + 18, size: 9, bold: true, maxWidth: width - 18, gap: 0.2 });
            write(check.detail, { x: margin + 18, size: 8.5, tone: 'muted', maxWidth: width - 18, gap: check.fix && !compact ? 0.2 : 1.6 });
            if (check.fix && !compact) write(`Fix: ${check.fix}`, { x: margin + 18, size: 8, tone: 'muted', maxWidth: width - 18, gap: 1.6 });
            if (y - top < 5) y = top + 5;
        }
        if (item.events.length) {
            y += 2; rule();
            write(`Preview events (${item.events.length})`, { size: 10, bold: true, gap: 1.5 });
            for (const event of item.events.slice(0, 40)) write(`${event.elapsed.toFixed(1)}s  ${event.kind.toUpperCase()}  ${event.detail}`, { size: 8, tone: event.kind === 'error' ? 'fail' : 'muted', gap: 0.6 });
        }
        y += 3;
        write(`SHA-256  ${item.hash || 'Unavailable'}`, { size: 7, tone: 'muted', font: 'courier', gap: 0 });
    }

    const pages = doc.getNumberOfPages();
    for (let page = 1; page <= pages; page++) {
        doc.setPage(page); doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); colour('muted');
        doc.text("Sunshine's Creative QA  |  Local preflight; not platform approval", margin, 291);
        doc.text(`Page ${page} of ${pages}`, margin + width, 291, { align: 'right' });
    }
    doc.save(`Creative_QA_${new Date().toISOString().slice(0, 10)}.pdf`);
}

$('allFiles').addEventListener('change', event => addFiles(event.target.files));
$('run-all').onclick = runBatch;
$('cancel-run').onclick = () => { state.cancelled = true; state.worker?.cancel(); window.electronAPI?.cancelAnalyses().catch(() => {}); setStatus('Cancelling current analysis'); };
$('clear-all').onclick = () => { releasePreview(); for (const item of state.items) if (item.objectURL) URL.revokeObjectURL(item.objectURL); state.items = []; state.selected = null; state.dirty = false; $('allFiles').value = ''; setStatus('No creatives queued'); render(); };
$('search').oninput = () => { renderQueue(); refreshIcons(); };
$('type-filter').onchange = () => { renderQueue(); refreshIcons(); };
$('sort-order').onchange = () => { renderQueue(); refreshIcons(); };
for (const button of document.querySelectorAll('[data-filter]')) button.onclick = () => { state.filter = button.dataset.filter; for (const sibling of document.querySelectorAll('[data-filter]')) sibling.setAttribute('aria-pressed', String(sibling === button)); renderQueue(); refreshIcons(); };
for (const id of fields) $(id).addEventListener('input', () => {
    const group = $(id).closest('[data-group]').dataset.group;
    const affected = state.items.filter(item => group === 'all' || profileForKind({}, item.kind).group === group);
    refreshPlaceholders();
    if (affected.some(item => item.id === state.selected)) releasePreview();
    for (const item of affected) { item.profile = null; item.status = 'pending'; item.checks = []; item.reviewed = false; }
    state.dirty = false;
    if (affected.length) setStatus('Type limits changed. QA required for affected assets.');
    try { localStorage.setItem('sunshine-settings', JSON.stringify(Object.fromEntries(fields.map(field => [field, $(field).type === 'checkbox' ? $(field).checked : $(field).value])))); } catch (_) {}
    render();
});
for (const key of ['width', 'height', 'duration']) $(`asset-${key}`).oninput = () => {
    const item = selected(); if (!item || state.running) return;
    const input = $(`asset-${key}`);
    if (!input.checkValidity()) { input.reportValidity(); return; }
    item.overrides = { ...(item.overrides || {}) };
    if (input.value === '') delete item.overrides[key]; else item.overrides[key] = Number(input.value);
    releasePreview(); item.profile = null; item.status = 'pending'; item.checks = []; item.reviewed = false;
    setStatus('Asset limits changed. QA required.'); render();
};
$('checks-tab').onclick = () => selectTab('checks'); $('preview-tab').onclick = () => selectTab('preview');
for (const id of ['checks-tab', 'preview-tab']) $(id).onkeydown = event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const name = event.key === 'Home' ? 'checks' : event.key === 'End' ? 'preview' : id === 'checks-tab' ? 'preview' : 'checks'; selectTab(name); $(`${name}-tab`).focus(); } };
$('review-confirmed').onchange = () => { const item = selected(); if (!item) return; item.reviewed = $('review-confirmed').checked; item.reviewedAt = item.reviewed ? new Date().toISOString() : null; render(); };
$('restart-preview').onclick = () => { const item = selected(); if (item?.kind === 'html5' && state.preview) loadHTMLPreview(item); else { const media = $('preview-stage').querySelector('video,audio'); if (media) { media.currentTime = 0; media.pause(); } else renderPreviewPlaceholder(); } };
$('preview-size').onclick = () => { state.actualSize = !state.actualSize; $('preview-stage').classList.toggle('actual', state.actualSize); $('preview-size').setAttribute('aria-pressed', String(state.actualSize)); $('preview-size').title = state.actualSize ? 'Fit preview' : 'Show actual size'; $('preview-size').setAttribute('aria-label', $('preview-size').title); state.preview?.fit(); };
for (const swatch of document.querySelectorAll('[data-background]')) swatch.onclick = () => { for (const sibling of document.querySelectorAll('[data-background]')) sibling.setAttribute('aria-pressed', String(sibling === swatch)); $('preview-stage').classList.remove('checker', 'white', 'black'); $('preview-stage').classList.add(swatch.dataset.background); };
window.addEventListener('message', event => {
    const preview = state.preview;
    if (!preview || event.source !== preview.frame.contentWindow || event.data?.creativeQA !== preview.token || !['loaded', 'exit', 'error'].includes(event.data.kind)) return;
    recordPreviewEvent(event.data.kind, event.data.detail);
});
window.electronAPI?.onPreviewNavigation(url => {
    if (!state.preview) return;
    recordPreviewEvent('exit', `Navigation blocked: ${url}`);
    // A cancelled navigation leaves the frame on an error page, so restore the creative.
    setTimeout(() => { const item = selected(); if (item?.kind === 'html5' && state.preview) loadHTMLPreview(item); }, 800);
});
function recordPreviewEvent(kind, rawDetail) {
    const preview = state.preview;
    const item = selected(); if (!item || item.events.length >= 200) return;
    const detail = String(rawDetail).slice(0, 2000);
    item.events.push({ kind, detail, elapsed: (performance.now() - preview.started) / 1000, at: new Date().toISOString() });
    if (kind === 'error') {
        item.checks.push(result('Runtime error', 'fail', detail, 'Inspect the creative source and failed resources.'));
        item.reviewed = false;
        item.status = 'fail';
        renderQueue(); renderInspector(); refreshIcons();
    } else renderEvents();
    if (kind === 'exit') showExitToast(detail);
}
for (const name of ['dragenter', 'dragover']) $('dropzone').addEventListener(name, event => { event.preventDefault(); if (!state.running) $('dropzone').classList.add('drag-over'); });
for (const name of ['dragleave', 'drop']) $('dropzone').addEventListener(name, event => { event.preventDefault(); $('dropzone').classList.remove('drag-over'); if (name === 'drop') addFiles(event.dataTransfer.files); });
document.addEventListener('dragover', event => event.preventDefault()); document.addEventListener('drop', event => event.preventDefault());
$('export-pdf').onclick = () => { exportPDF(); document.querySelector('.export-menu').open = false; };
$('export-json').onclick = () => { const evidence = state.items.filter(item => item.profile).map(({ file, kind, profile, metadata, measurement, checks, events, hash, checkedAt, reviewed, reviewedAt, status }) => ({ filename: file.name, kind, profile, metadata, measurement, checks, events, hash, checkedAt, reviewed, reviewedAt, status })); download('Creative_QA_Evidence.json', new Blob([JSON.stringify(evidence, null, 2)], { type: 'application/json' })); document.querySelector('.export-menu').open = false; };
$('theme-toggle').onclick = () => { document.body.classList.toggle('dark'); try { localStorage.setItem('sunshine-theme', document.body.classList.contains('dark') ? 'dark' : 'light'); } catch (_) {} $('theme-toggle').replaceChildren(icon(document.body.classList.contains('dark') ? 'sun' : 'moon')); refreshIcons(); };
$('docs-button').onclick = () => { const url = $('display-profile').value === 'dv360' ? 'https://support.google.com/displayvideo/topic/6058302?hl=en' : 'https://support.google.com/campaignmanager/answer/3145300?hl=en'; if (window.electronAPI) window.electronAPI.openDocumentation(url).catch(error => setStatus(error.message)); else window.open(url, '_blank', 'noopener'); };
try {
    const settings = JSON.parse(localStorage.getItem('sunshine-settings') || '{}');
    if (Object.hasOwn(settings, 'reviewer')) delete settings.reviewer;
    const migration = { 'max-video-size': 'media-size', 'max-bitrate': 'media-bitrate' };
    for (const [oldKey, newKey] of Object.entries(migration)) if (settings[oldKey] !== undefined && settings[newKey] === undefined) settings[newKey] = settings[oldKey];
    if (settings['spec-name']) for (const group of ['display', 'image', 'media']) if (settings[`${group}-reference`] === undefined) settings[`${group}-reference`] = settings['spec-name'];
    for (const id of fields) if (settings[id] !== undefined) { if ($(id).type === 'checkbox') $(id).checked = !!settings[id]; else $(id).value = settings[id]; }
    localStorage.setItem('sunshine-settings', JSON.stringify(Object.fromEntries(fields.map(id => [id, $(id).type === 'checkbox' ? $(id).checked : $(id).value]))));
    if (localStorage.getItem('sunshine-theme') === 'dark') { document.body.classList.add('dark'); $('theme-toggle').replaceChildren(icon('sun')); }
} catch (_) {}
refreshPlaceholders();
if (!window.electronAPI) $('connection').textContent = 'Browser workspace';
render();