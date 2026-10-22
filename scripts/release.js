#!/usr/bin/env node
// One-command release: `npm run update` (or `npm run update -- minor` / `-- major`).
// Bumps the version, runs tests, builds, uploads to a GitHub draft, checks every
// file arrived, then publishes it so installed apps pick it up on next launch.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PACKAGE_FILE = path.join(ROOT, 'package.json');
const DIST = path.join(ROOT, 'dist');
// Kept in your Windows user folder, never in the project, so it can't end up inside the app.
const TOKEN_FILE = path.join(os.homedir(), '.creative-qa-release-token');
const API = process.env.RELEASE_API_BASE || 'https://api.github.com';

const say = message => console.log(`\n> ${message}`);
const fail = message => { const error = new Error(message); error.friendly = true; throw error; };
const readPackage = () => JSON.parse(fs.readFileSync(PACKAGE_FILE, 'utf8'));

// One shared reader so fast typing or pasting never loses an answer.
let input;
let muted = false;
const queued = [];
let waiting = null;
let inputClosed = false;
function reader() {
    if (input) return input;
    input = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
    input._writeToOutput = text => { if (!muted) process.stdout.write(text); };
    input.on('line', line => { if (waiting) { const done = waiting; waiting = null; done(line); } else queued.push(line); });
    input.on('close', () => { inputClosed = true; if (waiting) { const done = waiting; waiting = null; done(''); } });
    input.on('SIGINT', () => { process.stdout.write('\nCancelled.\n'); process.exit(1); });
    return input;
}
function ask(question, hidden = false) {
    reader();
    process.stdout.write(question);
    muted = hidden;
    return new Promise(resolve => {
        const done = line => { muted = false; if (hidden) process.stdout.write('\n'); resolve(String(line).trim()); };
        if (queued.length) done(queued.shift());
        else if (inputClosed) done('');
        else waiting = done;
    });
}
const askHidden = question => ask(question, true);
const closeInput = () => { if (input) input.close(); };

function run(command, args, env) {
    console.log(`\n$ ${command} ${args.join(' ')}`);
    const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', shell: true, env: { ...process.env, ...env } });
    if (result.status !== 0) fail(`"${command} ${args.join(' ')}" failed. Scroll up for the error.`);
}

function github(token) {
    return async (method, route, body) => {
        let response;
        for (let attempt = 1; !response; attempt++) {
            try {
                response = await fetch(`${API}${route}`, {
                method,
                headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'creative-qa-release', ...(body ? { 'Content-Type': 'application/json' } : {}) },
                body: body ? JSON.stringify(body) : undefined
                });
            } catch (error) {
                // Connections left idle during the long build can be dropped; a fresh attempt normally works.
                if (attempt >= 4) fail(`Couldn't reach GitHub (${error.cause?.code || error.message}). Check your internet connection or VPN and try again.`);
                await pause(2000 * attempt);
            }
        }
        const text = await response.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
        return { status: response.status, data };
    };
}

async function getToken(owner, repo) {
    // Try, in order: a GH_TOKEN set in Windows/terminal, the saved file, then ask.
    const candidates = [];
    if (process.env.GH_TOKEN) candidates.push({ token: process.env.GH_TOKEN.trim(), source: 'GH_TOKEN' });
    if (fs.existsSync(TOKEN_FILE)) candidates.push({ token: fs.readFileSync(TOKEN_FILE, 'utf8').trim(), source: 'file' });
    for (let typed = 0; typed <= 3; ) {
        let candidate = candidates.shift();
        if (!candidate) {
            if (typed === 3) break;
            typed++;
            console.log(`\nPaste your GitHub token for ${owner}/${repo} (it won't show on screen), then press Enter.`);
            candidate = { token: await askHidden('Token: '), source: 'typed' };
            if (!candidate.token) continue;
        }
        const { status, data } = await github(candidate.token)('GET', `/repos/${owner}/${repo}`);
        if (status === 200 && data?.permissions?.push !== false) {
            if (candidate.source === 'typed') {
                fs.writeFileSync(TOKEN_FILE, candidate.token, { mode: 0o600 });
                console.log(`Token works and is saved. You won't be asked again until it expires (${TOKEN_FILE}).`);
            }
            return candidate.token;
        }
        const where = { GH_TOKEN: 'The GH_TOKEN saved in Windows', file: 'Your saved token', typed: 'That token' }[candidate.source];
        console.log(status === 200 ? `${where} can read the repo but can't publish. It needs Contents: Read and write.` : `${where} was rejected by GitHub (HTTP ${status}); it has probably expired or been deleted.`);
        if (candidate.source === 'file') fs.rmSync(TOKEN_FILE, { force: true });
        if (candidate.source === 'GH_TOKEN') console.log('  (To clear it for good, run: [Environment]::SetEnvironmentVariable("GH_TOKEN", $null, "User") and reopen VS Code.)');
    }
    fail('No working token after 3 tries.');
}

function nextVersion(current, bump) {
    const parts = current.split('.').map(Number);
    if (parts.length !== 3 || parts.some(Number.isNaN)) fail(`Can't read the current version "${current}" in package.json.`);
    if (bump === 'major') return `${parts[0] + 1}.0.0`;
    if (bump === 'minor') return `${parts[0]}.${parts[1] + 1}.0`;
    return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

function readLatestYml() {
    const file = path.join(DIST, 'latest.yml');
    if (!fs.existsSync(file)) fail('The build finished but dist\\latest.yml is missing.');
    const text = fs.readFileSync(file, 'utf8');
    const version = /^version:\s*['"]?([^'"\s]+)/m.exec(text)?.[1];
    const installer = /^path:\s*['"]?([^'"\r\n]+?)['"]?\s*$/m.exec(text)?.[1];
    return { version, installer };
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
    if (typeof fetch !== 'function') fail('This needs Node 18 or newer. Run "node -v" to check.');
    const pkg = readPackage();
    const publish = [].concat(pkg.build?.publish || [])[0] || {};
    const { owner, repo } = publish;
    if (publish.provider !== 'github' || !owner || !repo) fail('package.json is missing the GitHub publish settings.');
    if (publish.releaseType !== 'draft') fail('package.json "releaseType" must be "draft" (this script publishes the draft once every file is checked).');

    console.log(`\nCreative QA Tool release -> github.com/${owner}/${repo}`);
    const token = await getToken(owner, repo);
    const api = github(token);

    const latest = await api('GET', `/repos/${owner}/${repo}/releases/latest`);
    const bump = ['major', 'minor', 'patch'].includes(process.argv[2]) ? process.argv[2] : 'patch';
    const oldVersion = pkg.version;
    const version = nextVersion(oldVersion, bump);
    const tag = `v${version}`;
    console.log(`\nVersion in package.json: ${oldVersion}`);
    console.log(`Live on GitHub right now: ${latest.status === 200 ? latest.data.tag_name : 'nothing published yet'}`);
    console.log(`This release will be:    ${version}`);

    const releases = await api('GET', `/repos/${owner}/${repo}/releases?per_page=100`);
    if (releases.status !== 200) fail(`Couldn't list releases (HTTP ${releases.status}).`);
    const sameTag = releases.data.filter(release => release.tag_name === tag);
    const existing = sameTag.find(release => !release.draft) || sameTag[0];
    if (existing && !existing.draft) fail(`${tag} is already published. Bump the version in package.json past it, or run "npm run update -- minor".`);

    const notes = await ask('\nWhat changed? One line for the "What\'s new" note (Enter to skip): ');
    const confirm = await ask(`Build and publish ${version} to everyone? (y/n): `);
    closeInput(); // all questions asked; hand the terminal to the build tools
    if (!/^y(es)?$/i.test(confirm)) { console.log('Cancelled. Nothing changed.'); return; }

    for (const stale of sameTag.filter(release => release.draft)) {
        say(`Removing a leftover unpublished draft for ${tag} from an earlier attempt`);
        await api('DELETE', `/repos/${owner}/${repo}/releases/${stale.id}`);
    }
    // Create the one draft ourselves so electron-builder's parallel uploads reuse it instead of each making their own.
    const precreated = await api('POST', `/repos/${owner}/${repo}/releases`, { tag_name: tag, name: version, body: notes, draft: true, prerelease: false });
    if (precreated.status !== 201) fail(`Couldn't create the draft release (HTTP ${precreated.status}): ${JSON.stringify(precreated.data)}`);

    let bumped = false;
    try {
        say(`Setting version to ${version}`);
        run('npm', ['version', version, '--no-git-tag-version', '--allow-same-version']);
        bumped = true;

        say('Running tests');
        run('npm', ['test']);
        say('Building the interface');
        run('npm', ['run', 'build:ui']);
        say('Building the installer and uploading it to a GitHub draft (the upload can take a few minutes)');
        fs.rmSync(path.join(DIST, 'latest.yml'), { force: true });
        run('npx', ['electron-builder', '--win', '--publish', 'always'], { GH_TOKEN: token });

        say('Checking the build');
        const built = readLatestYml();
        if (built.version !== version) fail(`dist\\latest.yml says ${built.version}, expected ${version}.`);
        const expected = { 'latest.yml': path.join(DIST, 'latest.yml'), [built.installer]: path.join(DIST, built.installer), [`${built.installer}.blockmap`]: path.join(DIST, `${built.installer}.blockmap`) };
        for (const [name, file] of Object.entries(expected)) if (!fs.existsSync(file)) fail(`The build did not produce ${name}.`);

        say('Checking every file reached GitHub');
        let draft;
        for (let attempt = 0; attempt < 5 && !draft; attempt++) {
            if (attempt) await pause(3000);
            const list = await api('GET', `/repos/${owner}/${repo}/releases?per_page=100`);
            draft = list.data?.find?.(release => release.tag_name === tag);
        }
        if (!draft) fail(`No draft release for ${tag} was found on GitHub after the upload.`);
        for (const [name, file] of Object.entries(expected)) {
            const asset = draft.assets.find(item => item.name === name);
            const size = fs.statSync(file).size;
            if (!asset || asset.state !== 'uploaded' || asset.size !== size) fail(`${name} is missing or incomplete on GitHub. The draft has been left so you can look; just run "npm run update" again.`);
            console.log(`  ok  ${name} (${(size / 1048576).toFixed(1)} MB)`);
        }

        say('Publishing');
        const tagRef = await api('GET', `/repos/${owner}/${repo}/git/ref/tags/${tag}`);
        if (tagRef.status === 404) {
            const branch = draft.target_commitish || 'main';
            const head = await api('GET', `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
            if (head.status !== 200) fail(`Couldn't find the "${branch}" branch in ${repo} to attach the tag to.`);
            const created = await api('POST', `/repos/${owner}/${repo}/git/refs`, { ref: `refs/tags/${tag}`, sha: head.data.object.sha });
            if (created.status !== 201) fail(`Couldn't create tag ${tag} (HTTP ${created.status}): ${JSON.stringify(created.data)}`);
        }
        const published = await api('PATCH', `/repos/${owner}/${repo}/releases/${draft.id}`, { tag_name: tag, name: version, body: notes, draft: false, prerelease: false, make_latest: 'true' });
        if (published.status !== 200) fail(`GitHub refused to publish (HTTP ${published.status}): ${JSON.stringify(published.data)}`);
        bumped = false; // released: keep the new version

        let live = '';
        for (let attempt = 0; attempt < 5 && live !== tag; attempt++) {
            if (attempt) await pause(2000);
            live = (await api('GET', `/repos/${owner}/${repo}/releases/latest`)).data?.tag_name;
        }
        if (live !== tag) fail(`${tag} was published but GitHub still reports ${live} as Latest. Check the Releases page.`);

        console.log(`\nDone. ${version} is live.`);
        console.log('Anyone with the app gets it the next time they open it.');
        console.log(`Installer for brand-new users: ${path.join(DIST, built.installer)}`);
        console.log(`Or share this download link: https://github.com/${owner}/${repo}/releases/download/${tag}/${encodeURIComponent(built.installer)}`);
    } finally {
        if (bumped) {
            console.log(`\nPutting the version back to ${oldVersion} because the release didn't finish.`);
            spawnSync('npm', ['version', oldVersion, '--no-git-tag-version', '--allow-same-version'], { cwd: ROOT, stdio: 'ignore', shell: true });
        }
    }
}

main().then(closeInput, error => {
    closeInput();
    console.error(`\nRelease stopped: ${error.friendly ? error.message : error.stack || error}`);
    process.exit(1);
});
