const { test } = require('node:test');
const assert = require('node:assert/strict');
const qa = require('../qa-core');

test('mixed batches select separate display, image and media settings', () => {
    const profiles = { display: { width: 300, height: 250, duration: 30 }, image: { width: 728, height: 90, duration: 15 }, media: { width: 1920, height: 1080, duration: 60, loudness: -23 } };
    assert.equal(qa.profileForKind(profiles, 'html5').width, 300);
    assert.equal(qa.profileForKind(profiles, 'image').width, 728);
    assert.equal(qa.profileForKind(profiles, 'video').duration, 60);
    const audio = qa.profileForKind(profiles, 'audio');
    assert.equal(audio.loudness, -23);
    assert.equal(audio.width, undefined);
    const override = qa.profileForKind(profiles, 'image', { width: 320, height: 50 });
    assert.equal(override.width, 320);
    assert.equal(profiles.image.width, 728);
});

test('comments cannot satisfy click checks', () => {
    const checks = qa.analyzeScripts([{ name: 'index.html', content: '/* var clickTag="https://example.com"; window.open(clickTag); */' }]);
    assert.equal(checks[0].status, 'fail');
});
test('external executable click code is recognised but still needs runtime review', () => {
    const checks = qa.analyzeScripts([{ name: 'click.js', content: 'var clickTag="https://example.com"; document.onclick=()=>window.open(clickTag);' }]);
    assert.equal(checks[0].status, 'note');
});
test('function-local clickTag is not an injectable global', () => {
    assert.equal(qa.analyzeScripts([{ name: 'click.js', content: 'function click(){var clickTag="https://example.com"; window.open(clickTag)}' }])[0].status, 'fail');
});
test('hardcoded destinations are independent of a supported clickTag', () => {
    const checks = qa.analyzeScripts([{ name: 'click.js', content: 'var clickTag="https://example.com"; window.open(clickTag);\nwindow.open("https://fixed.example");' }]);
    assert.equal(checks[0].status, 'note');
    const hardcoded = checks.find(check => check.label === 'Hardcoded click destinations');
    assert.equal(hardcoded.status, 'warning');
    assert.match(hardcoded.detail, /click.js:2.*https:\/\/fixed.example/);
    assert.equal(qa.statusFor(checks), 'review');
});
test('normal clickTag defaults and asset URLs do not trigger destination warnings', () => {
    const checks = qa.analyzeScripts([{ name: 'click.js', content: 'var clickTag="https://example.com"; const image="https://cdn.example/image.png"; window.open(clickTag);' }]);
    assert.equal(checks.find(check => check.label === 'Hardcoded click destinations').status, 'pass');
});
test('fixed configuration, constructed and encoded URLs are detected at navigation sinks', () => {
    for (const content of [
        'const settings={destination:"https://fixed.example"}; location.assign(settings.destination);',
        'const domain="fixed.example"; location.href="https://"+domain+"/landing";',
        'const domain="fixed.example"; location.replace(`https://${domain}/landing`);',
        'window.open(atob("aHR0cHM6Ly9maXhlZC5leGFtcGxl"));',
        'Enabler.exitOverride("Exit", "https://fixed.example");',
        'var clickTag="https://default.example"; function click(){clickTag="https://fixed.example"; window.open(clickTag)}'
    ]) {
        const check = qa.analyzeScripts([{ name: 'click.js', content }]).find(check => check.label === 'Hardcoded click destinations');
        assert.equal(check.status, 'warning', content);
        assert.match(check.detail, /https:\/\/fixed.example/, content);
    }
});
test('unresolved destinations and unavailable code require review', () => {
    assert.equal(qa.analyzeScripts([{ name: 'click.js', content: 'window.open(getDestination());' }]).find(check => check.label === 'Hardcoded click destinations').status, 'unverified');
    assert.equal(qa.analyzeScripts([], 'display', true).find(check => check.label === 'Hardcoded click destinations').status, 'unverified');
    assert.equal(qa.analyzeScripts([], 'display', false, true).find(check => check.label === 'Hardcoded click destinations').status, 'unverified');
});
test('HTML links, forms and data attribute destinations are inspected', () => {
    const htmlElements = [
        { tag: 'a', attributes: { id: 'exit', href: 'https://fixed.example/link', 'data-url': 'https://fixed.example/data' }, location: 'index.html: <a id="exit">' },
        { tag: 'form', attributes: { action: '/landing' }, location: 'index.html: <form>' },
        { tag: 'button', attributes: { formaction: 'landing.html' }, location: 'index.html: <button>' },
        { tag: 'img', attributes: { src: 'https://cdn.example/image.png' }, location: 'index.html: <img>' }
    ];
    const checks = qa.analyzeScripts([{ name: 'click.js', content: 'const button=document.getElementById("exit"); window.open(button.dataset.url); location.assign(button.getAttribute("data-url"));' }], 'display', false, false, htmlElements);
    const hardcoded = checks.find(check => check.label === 'Hardcoded click destinations');
    assert.equal(hardcoded.status, 'warning');
    for (const destination of ['https://fixed.example/link', 'https://fixed.example/data', '/landing', 'landing.html']) assert.ok(hardcoded.detail.includes(destination));
    assert.match(hardcoded.detail, /click.js:1/);
    assert.doesNotMatch(hardcoded.detail, /cdn.example/);
});
test('assignments, scoped variables and cross-file configuration are resolved conservatively', () => {
    const checks = qa.analyzeScripts([
        { name: 'config.js', content: 'const destination="https://fixed.example";' },
        { name: 'click.js', content: 'window.open(destination); let url; url="https://assigned.example"; location.replace(url); function click(destination){window.open(destination)}' }
    ]);
    const hardcoded = checks.find(check => check.label === 'Hardcoded click destinations');
    assert.match(hardcoded.detail, /https:\/\/fixed.example/);
    assert.match(hardcoded.detail, /https:\/\/assigned.example/);
    assert.equal(checks.find(check => check.label === 'Dynamic click destinations').status, 'unverified');
});
test('clickTag aliases and fragment links do not produce hardcoded warnings', () => {
    const checks = qa.analyzeScripts([{ name: 'click.js', content: 'window.clickTag="https://default.example"; const destination=window.clickTag; window.open(destination);' }], 'display', false, false, [{ tag: 'a', attributes: { href: '#exit' }, location: 'index.html: <a>' }]);
    assert.equal(checks.find(check => check.label === 'Hardcoded click destinations').status, 'pass');
});
test('stylesheet href assignments are not click destinations', () => {
    const checks = qa.analyzeScripts([{ name: 'assets.js', content: 'const link=document.createElement("link"); link.href="https://cdn.example/style.css"; link.setAttribute("href", "https://cdn.example/other.css");' }]);
    assert.equal(checks.find(check => check.label === 'Hardcoded click destinations').status, 'pass');
});
test('alternate global clickTag assignments and DOM link setters are flagged', () => {
    const checks = qa.analyzeScripts([{ name: 'click.js', content: 'window.clickTag="https://default.example"; globalThis.clickTag="https://fixed.example"; const link=document.createElement("a"); link.href="https://fixed.example/link"; link.setAttribute("href", "https://fixed.example/other");' }]);
    const hardcoded = checks.find(check => check.label === 'Hardcoded click destinations');
    assert.equal(hardcoded.status, 'warning');
    assert.match(hardcoded.detail, /clickTag reassignment -> https:\/\/fixed.example/);
    assert.match(hardcoded.detail, /https:\/\/fixed.example\/link/);
    assert.match(hardcoded.detail, /https:\/\/fixed.example\/other/);
    assert.doesNotMatch(hardcoded.detail, /default.example/);
});
test('Studio exits do not require display clickTag or untracked fallback', () => {
    assert.equal(qa.analyzeScripts([{ name: 'exit.js', content: 'Enabler.exit("Primary exit");' }], 'studio')[0].status, 'note');
});
test('CSS animation combines separate duration, count and delay', () => {
    const check = qa.analyzeAnimation([{ content: '.ad {animation-duration:20s;animation-iteration-count:3;animation-delay:2s}' }], 30);
    assert.equal(check.status, 'fail');
    assert.match(check.detail, /62.00s/);
});
test('CSS shorthand and milliseconds are measured', () => {
    assert.equal(qa.analyzeAnimation([{ content: '.ad {animation:fade 500ms 2s 3}' }], 3).status, 'fail');
    assert.equal(qa.analyzeAnimation([{ content: '.ad {animation:fade 2s infinite}' }], 30).status, 'fail');
});
test('undetected animation is an advisory note, not a pass or block', () => {
    assert.equal(qa.analyzeAnimation([], 30).status, 'note');
    assert.equal(qa.statusFor([qa.result('a', 'pass', ''), qa.result('b', 'note', '')]), 'pass');
});
test('Google-hosted runtimes are trusted and make a missing local exit advisory', () => {
    assert.equal(qa.isTrustedHost('s0.2mdn.net'), true);
    assert.equal(qa.isTrustedHost('example.com'), false);
    assert.equal(qa.analyzeScripts([], 'display', false, true)[0].status, 'note');
    assert.equal(qa.analyzeScripts([{ name: 'a.js', content: 'var u="http://www.google.com";' }], 'display', false, true).find(check => check.label === 'HTTP strings').status, 'note');
});
test('references resolve relative to the owning CSS file and preserve case', () => {
    assert.equal(qa.resolveReference('css/style.css', '../images/Bg.png?v=2#asset'), 'images/Bg.png');
    assert.equal(qa.resolveReference('index.html', './click.js'), 'click.js');
    assert.equal(qa.resolveReference('index.html', 'https://example.com/ad.js'), null);
    assert.throws(() => qa.resolveReference('index.html', '../private.txt'));
});
test('malformed GIF terminates with a descriptive error', () => {
    const bytes = new Uint8Array([71,73,70,56,57,97,1,0,1,0,0,0,0,0x21,0xfe,5]);
    assert.throws(() => qa.inspectGif(bytes.buffer), /Truncated/);
});
test('valid static GIF is parsed by gifuct-js', () => {
    const bytes = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    const data = qa.inspectGif(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    assert.equal(data.frames, 1);
    assert.equal(data.animated, false);
});
test('review status cannot be confused with a pass', () => {
    assert.equal(qa.statusFor([{ status: 'unverified' }]), 'review');
    assert.equal(qa.statusFor([{ status: 'pass' }, { status: 'fail' }]), 'fail');
});
test('video loudness is checked only against the selected target', () => {
    const checks = qa.checkVideo({ duration: 15 }, { lufs: -16, truePeak: -1 }, { duration: 30, loudness: -23, tolerance: 1, truePeak: -2 });
    assert.equal(checks.find(check => check.label === 'Integrated loudness').status, 'fail');
    assert.equal(checks.find(check => check.label === 'True peak').status, 'fail');
});
test('remote scripts are inconclusive rather than a false click failure', () => {
    assert.equal(qa.analyzeScripts([], 'display', true)[0].status, 'unverified');
});
test('Google Web Designer exits are supported without forcing a display clickTag', () => {
    assert.equal(qa.analyzeScripts([{ name: 'gwd.js', content: 'gwd.actions.gwdGoogleAd.exit("ad", "exit");' }])[0].status, 'note');
});
test('video codec, channels and frame rate respect the selected specification', () => {
    const checks = qa.checkVideo({ videoCodec: 'h264', audioCodec: 'aac', channels: 1, frameRate: 25 }, null, { videoCodec: 'h264', audioCodec: 'aac', channels: 2, frameRate: 30 });
    assert.equal(checks.find(check => check.label === 'Video codec').status, 'pass');
    assert.equal(checks.find(check => check.label === 'Audio channels').status, 'fail');
    assert.equal(checks.find(check => check.label === 'Frame rate').status, 'fail');
});
test('destination presets override the general baseline for display only', () => {
    assert.equal(qa.defaultsFor('cm360').display.maxFiles, 100);
    assert.equal(qa.defaultsFor('cm360').image.maxKB, 9728);
    assert.equal(qa.defaultsFor('auto'), qa.DEFAULTS);
});

test('images may be 2x the expected or standard size but not HTML5', () => {
    const at = (width, height) => ({ width, height });
    const expected = { width: 300, height: 250, baseline: true };
    assert.equal(qa.dimensionCheck(at(600, 500), expected, true).status, 'pass');
    assert.equal(qa.dimensionCheck(at(600, 500), expected, false).status, 'fail');
    assert.equal(qa.dimensionCheck(at(600, 400), expected, true).status, 'fail');
    assert.equal(qa.dimensionCheck(at(600, 500), { baseline: true }, true).status, 'pass');
    assert.equal(qa.dimensionCheck(at(5000, 4000), { width: 2500, height: 2000 }, true).status, 'fail');
    assert.equal(qa.dimensionCheck(at(601, 500), { baseline: true }, true).status, 'warning');
});
