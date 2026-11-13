# Developing Playmart

Technical setup, architecture, testing, packaging, and release guidance. For application usage, see [README.md](./README.md).

## Architecture

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

The Electron window uses `assets/logo.png`. After replacing this square logo (at least 1024 Ã— 1024 pixels), run `npm run icons` to regenerate the Windows, macOS, and Linux package icons in `assets/icons/` before packaging.

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

The Windows release workflow builds both a portable executable and an NSIS installer, uploading each as a workflow artifact and attaching both to the GitHub release. It derives the embedded app version and filenames from the release tag (`v0.1.2` produces `Playmart-0.1.2-portable.exe` and `Playmart-0.1.2-setup.exe`), updating both package manifests in the CI checkout before packaging. Packaging explicitly disables electron-builder publishing (`--publish never`), including automatic publishing on tag builds; the separate GitHub CLI release step handles uploads using the workflow token. Manual runs use the supplied release tag and checked-out source commit. Release titles use `Playmart vX.Y.Z`. These CI version changes are not committed back to the repository.

The Windows release workflow uses the GitHub Actions `prod` environment. Configure its `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` secrets before publishing a release; the packaging step validates their presence and embeds these public client settings during the build. Never use a service-role/secret key for the desktop app.

Build native packages on their target operating system for the most reliable results. macOS signing/notarization requires macOS and Apple developer tooling; this project does not configure signing credentials. Linux package formats may require distribution-specific build dependencies. Windows, MacOS, and Linux packages have not all been validated from one machine.

### Packaged archive extraction

Packaged builds run the bundled 7-Zip executable from `resources/app.asar.unpacked`, not from the virtual `app.asar` archive. Keep `7zip-bin` in the packaging `asarUnpack` list. The Windows release workflow checks that the unpacked executable exists and can run before publishing.

### Supabase setup

Run [`supabase/migrations/20261105000000_catalog.sql`](./supabase/migrations/20261105000000_catalog.sql) in the Supabase SQL editor, then manually populate `games` and its matching `game_details` row. Link objects use JSON objects; `mod_links` is an array of the existing mod objects, including `steps_to_apply`.

In Supabase Auth, enable new users and anonymous sign-ins, keep email confirmation disabled to avoid requiring email verification, and enable manual identity linking so an anonymous user can be upgraded without changing their user ID. Catalog reads are permitted only to the `authenticated` role; anonymous Auth users receive a JWT with that role. Run any newer SQL migrations in order, including `20261105143500_authenticated_catalog_access.sql` if the original catalog migration was already applied. The desktop app uses only the publishable key and read-only catalog access; never put a service-role key in the app or `.env.local`.

ZIP, 7z, and RAR archives are extracted with the bundled 7-Zip executable. Archive paths and links are checked before extraction. Launcher processes are started without a shell.

## Security notes

Electron windows use context isolation, sandboxing, and disabled Node integration. The preload exposes only the library operations needed by the UI. IPC validates payloads, download URLs are checked against the selected game's catalog links, external links and network redirects must use HTTPS and cannot target localhost, and the download destination must be an existing folder. SQLite data and encrypted auth session data are stored in Electron's per-user application data directory.

### Playmart data folders

Playmart always uses `Playmart Data` beside portable executables or `Playmart` inside the OS application-data directory for desktop runs. Older application-data folders are not detected, reused or migrated. The storage cleanup utility targets only the Playmart desktop folder. The Library navigation label denotes the collection page, not the product name.
