# Game Library

A cross-platform desktop game library built with Electron, React, TypeScript, and Vite. Supabase is the source of truth for the public game catalog and authentication. SQLite caches catalog data for offline browsing and stores device-local download/install state. The Python CLI in `py_box/` remains available independently.

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

Install Node.js 20.19+ (or 22.12+) and the platform's native build prerequisites for `better-sqlite3`. Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in the ignored `.env.local` file, then run:

```powershell
npm install
npm run dev
```

The Electron main process owns filesystem access, downloads, archive extraction, SQLite, and game launching. Renderer code has no Node integration. A narrow, typed preload API bridges the renderer to validated IPC handlers.

## Tests and builds

Run the automated checks:

```powershell
npm run typecheck
npm test
npm run build
```

### Electron smoke testing

Use the `electron-tester` custom agent for interactive renderer smoke tests. Start the app with both the Node inspector and a renderer DevTools port:

```powershell
npm run dev -- --inspect=5858 --remote-debugging-port=9222 --sourcemap
```

Port `5858` is for attaching a Node debugger. Use port `9222` with Electron Debug MCP to inspect the renderer, navigate by accessible page controls, check console/network failures, and capture screenshots. Test at least Home, Downloads, Library, and Profile. Save screenshots or the generated HTML report under `test-artifacts/`; that folder is intentionally ignored by Git.

To reset the app's local Electron storage (SQLite catalog/download records, encrypted auth session, and Chromium cache/storage) without removing installed game folders:

```powershell
npm run clear:electron-storage
```

Close the app first, then type `CLEAR` when prompted. Use `npm run clear:electron-storage -- --dry-run` to inspect the target, or append `-- --yes` to skip confirmation.

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

Home shows the games fetched from Supabase; the last cached catalog remains available when the service is offline. Selecting a cover opens details and the download flow. Choose an existing destination folder, optionally select catalog mods, and optionally enable auto-run after installation. The game archive and selected mod files are kept in the game folder alongside extracted files. When retrying an install, existing game and mod archives are reused rather than downloaded again. Downloads are available from the left navigation and support pause, resume, and cancel. GoFile and Workupload links open in a dedicated browser window so the user can complete any host-page interaction. Other configured HTTPS links are downloaded directly. The Library page lists installed games and lets the user launch, stop, or delete them. Deletion removes the installed folder, including its kept archives. Missing install folders are reconciled during refresh and removed from the library.

### Supabase setup

Run [`supabase/migrations/20261105000000_catalog.sql`](./supabase/migrations/20261105000000_catalog.sql) in the Supabase SQL editor, then manually populate `games` and its matching `game_details` row. Link objects use JSON objects; `mod_links` is an array of the existing mod objects, including `steps_to_apply`.

In Supabase Auth, enable new users and anonymous sign-ins, keep email confirmation disabled to avoid requiring email verification, and enable manual identity linking so an anonymous user can be upgraded without changing their user ID. Catalog reads are permitted only to the `authenticated` role; anonymous Auth users receive a JWT with that role. Run any newer SQL migrations in order, including `20261105143500_authenticated_catalog_access.sql` if the original catalog migration was already applied. The desktop app uses only the publishable key and read-only catalog access; never put a service-role key in the app or `.env.local`.

ZIP, 7z, and RAR archives are extracted with the bundled 7-Zip executable. Archive paths and links are checked before extraction. Launcher processes are started without a shell.

## Security notes

Electron windows use context isolation, sandboxing, and disabled Node integration. The preload exposes only the library operations needed by the UI. IPC validates payloads, download URLs are checked against the selected game's catalog links, external links and network redirects must use HTTPS and cannot target localhost, and the download destination must be an existing folder. SQLite data and encrypted auth session data are stored in Electron's per-user application data directory.
