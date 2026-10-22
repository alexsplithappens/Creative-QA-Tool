# Sunshine's Creative QA Tool

Windows desktop preflight and manual review for HTML5 ZIPs, images, video, and audio.

## Run And Build

- `npm install` installs development dependencies.
- `npm start` bundles the UI locally and opens Electron.
- `npm test` runs engine, preview-service, and native Electron workflow tests. The native test needs the bundled Windows FFmpeg binaries.
- `npm run build:win` creates the Windows installer.
- `npm run build:win -- --dir` creates an unpacked Windows application for packaging checks.

The runtime does not depend on CDN scripts. Keep `ffmpeg/ffmpeg.exe` and `ffmpeg/ffprobe.exe` available (they are git-ignored; the project uses the gyan.dev 'essentials' build, about 100 MB each, with its GPL v3 licence in `ffmpeg/LICENSE.txt`); the build copies them to application resources. See `THIRD_PARTY_NOTICES.md` before redistributing.

The Help button shows known limits and the feedback address (alex.pearce@omc.com), with Copy diagnostics and Open log folder to help with bug reports. Errors are logged to `app.log` in the user-data `logs` folder.

Native tests use an isolated temporary user-data profile, not the operator's saved settings. `npm audit --omit=dev` is clear at verification time. Full audit still reports a moderate upstream `sprintf-js` advisory through electron-builder's proxy/logging dependencies; resolving it currently requires an installer-toolchain downgrade rather than a runtime fix.

## Review Workflow

Drop a mixed batch into one queue; each file's type (HTML5 ZIP, JPG/GIF/PNG image, video, audio) is detected automatically, and no up-front choice is needed. Run preflight and inspect exceptions. Filter and sort the queue by type or name.

There are two ways to check:

- **No input:** leave Optional limits empty and the built-in baseline applies: 200 KB and 30 s for HTML5 ZIPs, 200 KB and 30 s GIF playback for images, at most 100 ZIP files, standard ad sizes (non-standard sizes warn), and a -24 to -16 LUFS loudness range for video/audio. Structural checks (clickTag/exit, storage APIs, `ad.size`, UTF-8, dependencies, HTTPS) always run.
- **Your own spec:** open Optional limits and enter values. HTML5 display, image, and video/audio have independent fieldsets, and an entered value replaces the baseline for that type only. Video-only settings are ignored for audio. Select an asset and use Asset limits to override width, height, or duration for that file without changing the type defaults.

The reference, entered limits, and any defaulted values are recorded with each result and in the exports. Changing limits invalidates only the affected assets, which then need another run. Previously saved shared limits are not copied into every type.

The destination selects the exit-checking model and applicable structural checks. CM360 also swaps in its own display baseline (9.5 MB, 100 files, 30 s; images up to 9.5 MB), from the CM360 asset-options page. Images may also be exactly 2x the expected or standard slot size, up to 4000 x 4000 px. Untick Use baseline limits for empty fields to check only what you enter. The baseline is a general guide, not a publisher specification; enter the real limits when you have them.

The preview shows a Click captured notice and logs the exit for window.open calls, links (including javascript: links), Enabler.exit calls, and blocked page navigations. After a blocked navigation the preview reloads.

- **Blocked:** a hard failure was detected. A manual-review checkbox cannot override this.
- **Review:** warnings or checks that cannot be established statically remain.
- **Reviewed:** the operator acknowledged visual/interaction review; this is not platform approval.
- **Passed:** the automated checks present in the result passed.

The inspector provides on-demand previews, fit/actual size, backgrounds, restart, elapsed time, and captured exits/errors. Only the selected HTML5 creative runs. Preview clicks are captured rather than opening landing pages. Studio/Enabler behaviour must also be reviewed in the destination's official preview environment. Isolated previews may restrict APIs that exist in other serving environments.

The PDF report opens with a summary of totals and a one-line-per-asset table, then gives each asset its own page: status, specification and applied limits, checks grouped blocked, review, note, then passed, preview events, and SHA-256. Exports are disabled while running, after specification changes, or when a cancelled batch still contains unchecked assets. Remove unchecked assets or rerun to export.

## Boundaries

Static parsing recognises local executable JavaScript, display clickTags, GWD exit APIs, and Studio exits. Remote scripts are not fetched or approved. HTML/CSS references are resolved relative to their owning files with case-sensitive names. CSS duration includes repetitions/delays, but cascades, dynamic JavaScript animation, and the final frame still need playback review.

The independent hardcoded click destination check inspects HTML links/forms, inline handlers, and local `.js`, `.mjs`, and `.cjs` files. It warns on fixed navigation URLs, explicit exit URLs, and clickTag reassignments, including straightforward variables, object configuration, concatenation, templates, encoded strings, and HTML data attributes used by navigation code. Findings identify the script file/line or HTML element and destination. Normal global clickTag defaults and asset URLs are not treated as hardcoded click destinations; a supported clickTag elsewhere does not suppress warnings. Resolution is conservative, so a warning can include an inactive branch or unused local file and needs review rather than automatic rejection.

Unresolved destinations or unparsed/unavailable script code require review rather than claiming no hardcoded URLs exist. Static analysis does not execute creatives or fully trace arbitrary functions, runtime configuration/JSON, remote scripts, redirects, or obfuscated code. Always verify landing-URL overrides in the destination platform's preview; the local preview captures clicks but does not prove CM360 override behaviour.

GIF blocks are bounds-checked before gifuct-js parsing, including repeat timing. Border inspection is manual rather than a pixel heuristic presented as certainty. Video metadata is probed before audio measurement so silent clips retain codec/frame-rate data. No RMS-to-LUFS estimate is used. Missing or non-finite measurements remain unverified.

The app does not authenticate to GMP, submit creatives, guarantee platform acceptance, validate VAST redirects, or automatically map placements/backup assets. PDF text outside Latin-1 (for example Hindi or Chinese filenames) is drawn with the system fonts and embedded as images, so it prints correctly but is not selectable.

## Security And Structure

The Electron renderer is sandboxed without Node integration. IPC accepts only the application's main frame. HTML5 previews use an isolated, token-scoped localhost service and an opaque-origin iframe with `allow-scripts` only. Permissions, new windows, forms, and top-level navigation are restricted. Archive paths, file counts, and expanded sizes are bounded. Native media tools use argument arrays without a shell and only app-owned temporary paths. Temporary resources are removed on release/exit.

- `workspace.html`, `styles.css`, `renderer.js`: desktop queue and inspector.
- `qa-core.js`, `qa-worker.js`: parser-backed checks and background execution.
- `backend.js`: preview extraction/service, metadata, loudness, and cleanup.
- `main.js`, `preload.js`: Electron lifecycle and limited IPC bridge.
- `assets/*.bundle.js`: generated local bundles; regenerate with `npm run build:ui`.
- `tests/`: regressions and native desktop verification.

Safety caps are 500 MB per media asset, 50 MB per expanded ZIP, 1000 ZIP files, and 25 megapixels for decoded image/preview dimensions. These are application safety limits, not advertising delivery specifications.

The interface retains yellow as an action/selection accent with readable neutral text. The primary button adapts the restrained depth/pressed treatment from Uiverse; attribution is in `THIRD_PARTY_NOTICES.md`.
## Releasing

Updates are published to the public releases-only repo `alexsplithappens/creative-qa-releases` and installed automatically by the app (electron-updater). The source code is never uploaded.

**To release, save your changes and run `npm run update`** (not `npm update`, which upgrades dependencies instead). It will:

1. Ask for your GitHub token the first time only, check it works, and save it outside the project (`%USERPROFILE%\.creative-qa-release-token`) so it can never be bundled into the app.
2. Show the current and next version (patch bump by default; use `npm run update -- minor` or `-- major`), ask for a one-line "What's new" note, and ask you to confirm.
3. Bump the version, run the tests, build the UI and installer, and upload the installer, blockmap and `latest.yml` to a draft release.
4. Check all three files arrived complete, publish the release, mark it Latest, and confirm GitHub reports it as Latest.

If anything fails, the version number is put back and nothing is published; fix the problem and run it again (a leftover draft is cleaned up automatically). When the token expires, the script says so and asks for a new one.

Differential (blockmap) updates are enabled, so unchanged files such as the bundled ffmpeg are not re-downloaded.

### Minimum version

`policy.json` on the `main` branch of the releases repo controls the minimum supported version:

```json
{ "minVersion": "2.1.0", "message": "Please update to continue." }
```

On startup the app fetches it (5-second timeout). If the running version is lower, the app shows a blocking message and disables Run preflight until updated. If the fetch fails, the app stays usable (fail open).

### Upgrading from a per-machine install

The installer is now per-user (no admin rights, no install directory choice). Anyone on a previous per-machine install should uninstall it before installing this version.
