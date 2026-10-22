# CLAUDE.md

## Purpose
Sunshine's Creative QA Tool: Windows Electron desktop app for preflight and manual review of HTML5 ZIPs, images (JPG/GIF/PNG), video and audio before upload to ad platforms (CM360 etc.). Produces Blocked / Review / Reviewed / Passed statuses and a PDF report. It is a guide, not platform approval. See [README.md](README.md) for the full user-facing behaviour.

## Setup
- Node 24.13.0 (`.nvmrc`), npm 11. Electron 44 bundles its own runtime.
- `npm ci` then `npm test`, `npm start`, `npm run build:win`.
- `ffmpeg/ffmpeg.exe` and `ffmpeg/ffprobe.exe` are git-ignored (gyan.dev "essentials" build, ~100 MB each). Copy them manually; the native Electron test and video/audio checks fail without them.
- `assets/*.bundle.js` and `dist/` are generated (`npm run build:ui`), git-ignored.
- Releases: `npm run update` (scripts/release.js). Needs a GitHub token stored at `%USERPROFILE%\.creative-qa-release-token` (or `GH_TOKEN`), never in the repo. Publishes to `alexsplithappens/creative-qa-releases`.

## Architecture
- `main.js`, `preload.js`: Electron lifecycle, auto-update (electron-updater), limited IPC bridge. Renderer is sandboxed, no Node integration; IPC accepts main frame only.
- `renderer.js`, `workspace.html`, `styles.css`: queue and inspector UI. Bundled by esbuild to `assets/app.bundle.js`.
- `qa-core.js`, `qa-worker.js`: parser-backed checks (acorn, postcss) run in a worker; bundled to `assets/qa-worker.bundle.js`.
- `backend.js`: ZIP extraction, token-scoped localhost preview service, ffmpeg metadata/loudness, cleanup.
- `semver.js`: version comparison (new, with tests).
- `scripts/release.js`: release automation. `build-scripts/skip-chmod.js`: avoids EPERM during packaging.
- `tests/`: `node --test`. Fixtures are generated in code (JSZip, ffmpeg lavfi into a temp dir); there are no fixture files to copy.

## Decisions
- No CDN at runtime; everything local.
- HTML5 previews: opaque-origin iframe, `allow-scripts` only; clicks captured, not opened.
- Static analysis only; remote scripts are not fetched. Unresolvable items go to Review, never silently Pass.
- No RMS-to-LUFS estimate; unmeasurable values stay unverified.
- Per-user NSIS installer (no admin). Differential updates enabled; ffmpeg is shipped via `extraResources`.
- Native tests use an isolated temp user-data profile.
- Safety caps: 500 MB media, 50 MB expanded ZIP, 1000 ZIP files, 25 MP images.

## Known issues
- `npm audit` (full) reports a moderate `sprintf-js` advisory via electron-builder; production audit is clean. Fix needs a builder downgrade.
- `.vscode/launch.json` points to a stale path (`c:\Users\alex.pearce\...\index.html`) that no longer exists; harmless, should be removed.
- `build-scripts/skip-chmod.js` contains a mojibake character in its console message (encoding).
- Hardcoded-click-URL check is conservative; may warn on inactive branches or unused local files.
- Studio/Enabler behaviour and CM360 click overrides must be verified in the platform's own preview.
- Git line-ending warnings (LF vs CRLF); no `.gitattributes`.
- Working tree had large uncommitted changes at migration time (see Next steps).

## Next steps
1. Commit and push the pending work (modified sources, `semver.js`, `scripts/`, `tests/semver.test.js`, lockfile). `package.json` version is 2.2.3, but HEAD is v2.1.0-era.
2. Add `.gitattributes` (`* text=auto eol=lf`) to settle line endings.
3. Remove or fix `.vscode/launch.json`.
4. Consider a CI job (Windows runner) for `npm ci && npm test`, with ffmpeg downloaded in the workflow.
5. Revisit the electron-builder advisory when an upstream fix lands.
