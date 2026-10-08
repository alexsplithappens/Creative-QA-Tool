const { test } = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const { createBackend, safeRelativePath, finite } = require('../backend');

test('unsafe archive paths are rejected', () => {
    for (const value of ['../private.txt', '/absolute.html', 'C:/private.html', 'folder\\file.js', 'NUL.txt', 'folder/file.']) assert.throws(() => safeRelativePath(value));
    assert.equal(safeRelativePath('css/style.css'), 'css/style.css');
    assert.equal(finite('-inf'), null);
    assert.equal(finite('0'), 0);
});
test('preview service serves only extracted assets and revokes them', async () => {
    const backend = createBackend('ffmpeg');
    await backend.start();
    try {
        const zip = new JSZip();
        zip.file('index.html', '<html><head></head><body>Creative</body></html>');
        zip.file('fonts/brand.otf', 'font');
        const preview = await backend.extractCreative({ zipBuffer: await zip.generateAsync({ type: 'nodebuffer' }), mainHtmlFileName: 'index.html' });
        const response = await fetch(preview.url);
        assert.equal(response.status, 200);
        assert.match(await response.text(), /creativeQA/);
        assert.match(response.headers.get('content-security-policy'), /object-src 'none'/);
        assert.equal((await fetch(new URL('fonts/brand.otf', preview.url))).status, 200);
        await backend.releasePreview(preview.token);
        assert.equal((await fetch(preview.url)).status, 404);
    } finally { await backend.close(); }
});
test('JSZip sanitisation cannot hide an unsafe original path', async () => {
    const backend = createBackend('ffmpeg');
    await backend.start();
    try {
        const zip = new JSZip();
        zip.file('../index.html', 'unsafe');
        await assert.rejects(() => backend.extractCreative({ zipBuffer: zip.generateAsync({ type: 'nodebuffer' }), mainHtmlFileName: 'index.html' }));
        const buffer = await zip.generateAsync({ type: 'nodebuffer' });
        await assert.rejects(() => backend.extractCreative({ zipBuffer: buffer, mainHtmlFileName: 'index.html' }), /Unsafe/);
    } finally { await backend.close(); }
});