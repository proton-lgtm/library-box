# Redline Library

Redline Library is a cross-platform desktop game library built with Electron, React, TypeScript, and Vite. Its local SQLite catalog is seeded from [`py_box/games.json`](./py_box/games.json); the Python CLI in `py_box/` remains available independently.

The interface follows the supplied game-store references: deep navy surfaces, violet accents, subtle halftone texture, rounded artwork panels, and a compact collection sidebar. It uses the Inter variable font bundled locally with the app, so typography is consistent offline and across platforms.

## Recommended stack

| Area | Choice | Why it fits | Main tradeoff |
|---|---|---|---|
| Desktop shell | Electron + electron-builder | Mature Windows, macOS, and Linux support; familiar web stack | Larger application packages than native-webview shells |
| UI | React + TypeScript + Vite | Reuses the existing UI approach, fast development, typed components | Renderer/main process boundaries need deliberate IPC design |
| Local database | SQLite via better-sqlite3 | Lightweight, transactional, local-first storage | Native addon must be rebuilt and validated for each OS/architecture |
| Downloads | Node HTTPS streaming + Electron browser flow for GoFile/Workupload | Direct downloads support progress and range-based resume; browser flow handles interactive host pages without a host API | Resume depends on server support; browser-host pages may require user interaction |
| Archive extraction | Bundled 7-Zip via `7zip-bin` | One extractor supports ZIP, 7z, and RAR across platforms | Binary packaging/licensing and archive safety need attention; RAR support depends on the bundled 7-Zip build |
| Tests | Vitest + Testing Library | Covers renderer and desktop service logic in the existing test workflow | Native addon and platform-specific process behavior still need OS-specific validation |

## Development

Install Node.js 20.19+ (or 22.12+) and the platform's native build prerequisites for `better-sqlite3`, then run:

```powershell
npm install
npm run dev
```

The Electron main process owns filesystem access, downloads, archive extraction, SQLite, and game launching. Renderer code has no Node integration. A narrow, typed preload API bridges the renderer to validated IPC handlers.

## Tests and builds

```powershell
npm run typecheck
npm test
npm run build
```

Create a packaged application for the current host:

```powershell
npm run package:dir
```

Platform package scripts are also available:

```powershell
npm run package:win
npm run package:mac
npm run package:linux
```

Build native packages on their target operating system for the most reliable results. macOS signing/notarization requires macOS and Apple developer tooling; this project does not configure signing credentials. Linux package formats may require distribution-specific build dependencies. Windows, macOS, and Linux packages have not all been validated from one machine.

## Using the library

Home shows the games imported from `py_box/games.json`. Selecting a cover opens its details and the download flow. Choose an existing destination folder, optionally select catalog mods, and optionally enable auto-run after installation. Selected mods download after the base game, then their configured extract/move steps are applied to the staged install before it is added to the library. Downloads are available from the left navigation and support pause, resume, and cancel. GoFile and Workupload links open in a dedicated browser window so the user can complete any host-page interaction. Other configured HTTPS links are downloaded directly. The Library page lists installed games and lets the user launch or stop them.

ZIP, 7z, and RAR archives are extracted with the bundled 7-Zip executable. Archive paths and links are checked before extraction, and installation is promoted from a staging directory only after a compatible launcher is found. Launcher processes are started without a shell.

## Security notes

Electron windows use context isolation, sandboxing, and disabled Node integration. The preload exposes only the library operations needed by the UI. IPC validates payloads, download URLs are checked against the selected game's catalog links, network URLs and redirects must use HTTPS and cannot target localhost, and the download destination must be an existing folder. SQLite data is stored in Electron's per-user application data directory.
