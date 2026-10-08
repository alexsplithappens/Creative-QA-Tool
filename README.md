# Sunshine's Creative QA Tool

Windows desktop preflight and manual review for HTML5 ZIPs, images, and video.

## Run And Build

- `npm install` installs development dependencies.
- `npm start` bundles the UI locally and opens Electron.
- `npm test` runs engine, preview-service, and native Electron workflow tests. The native test needs the bundled Windows FFmpeg binaries.
- `npm run build:win` creates the Windows installer.
- `npm run build:win -- --dir` creates an unpacked Windows application for packaging checks.

The runtime does not depend on CDN scripts. Keep `ffmpeg/ffmpeg.exe` and `ffmpeg/ffprobe.exe` available; the build copies them to application resources. Review the existing FFmpeg distribution's licence obligations before distributing the installer.

Native tests use an isolated temporary user-data profile, not the operator's saved settings. `npm audit --omit=dev` is clear at verification time. Full audit still reports a moderate upstream `sprintf-js` advisory through electron-builder's proxy/logging dependencies; resolving it currently requires an installer-toolchain downgrade rather than a runtime fix.

## Review Workflow

Select the destination and enter limits from the current publisher/platform specification. Upload a mixed batch, run preflight, and inspect exceptions. Display/expanded-ZIP size and video size have separate limits. Delivery limits are deliberately not guessed from a universal 200 KB or loudness rule.

The destination selects the exit-checking model and applicable structural checks. It is not a complete, automatically updated specification catalogue. The reference and entered limits are captured with each result. Changing specifications invalidates earlier results and requires another run.

- **Blocked:** a hard failure was detected. A manual-review checkbox cannot override this.
- **Review:** warnings or checks that cannot be established statically remain.
- **Reviewed:** the operator acknowledged visual/interaction review; this is not platform approval.
- **Passed:** the automated checks present in the result passed.

The inspector provides on-demand previews, fit/actual size, backgrounds, restart, elapsed time, and captured exits/errors. Only the selected HTML5 creative runs. Preview clicks are captured rather than opening landing pages. Studio/Enabler behaviour must also be reviewed in the destination's official preview environment. Isolated previews may restrict APIs that exist in other serving environments.

All three reports use the same check objects. XLSX includes blockers, review items, specification, completion timestamps, and SHA-256. A second worksheet records entered limits. JSON preserves full structured evidence. PDF includes both successful checks and issues. Exports are disabled while running, after specification changes, or when a cancelled batch still contains unchecked assets. Remove unchecked assets or rerun to export. The materials worksheet is not a CM360/DV360 API import template.

## Boundaries

Static parsing recognises local executable JavaScript, display clickTags, GWD exit APIs, and Studio exits. Remote scripts are not fetched or approved. HTML/CSS references are resolved relative to their owning files with case-sensitive names. CSS duration includes repetitions/delays, but cascades, dynamic JavaScript animation, and the final frame still need playback review.

GIF blocks are bounds-checked before gifuct-js parsing, including repeat timing. Border inspection is manual rather than a pixel heuristic presented as certainty. Video metadata is probed before audio measurement so silent clips retain codec/frame-rate data. No RMS-to-LUFS estimate is used. Missing or non-finite measurements remain unverified.

The app does not authenticate to GMP, submit creatives, guarantee platform acceptance, validate VAST redirects, or automatically map placements/backup assets. PDF's built-in font supports Latin-1; use JSON/XLSX for filenames outside that character set.

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