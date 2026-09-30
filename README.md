# Redline Library

Redline is a Tauri 2 desktop library for discovering Ren'Py games, tracking verified public archive downloads, installing ZIP builds, and launching/stopping installed games. The catalog and transfer/install state are stored in a local SQLite database under the operating system's app-data directory.

## Run locally

Install Node.js 20.19+ (or 22.12+) and Rust stable with the platform's native build prerequisites. Then, from the project folder:

```powershell
npm install
npm run tauri dev
```

To run the frontend tests and production web build:

```powershell
npm test
npm run build
```

To run the Rust/SQLite and archive tests and produce the native package for the current host:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri build
```

For a Windows NSIS installer specifically:

```powershell
npm run tauri build -- --bundles nsis
```

Tauri desktop build prerequisites:

- **Windows:** Microsoft C++ Build Tools (MSVC), WebView2 runtime, and the Rust MSVC target.
- **macOS:** Xcode Command Line Tools and the Rust target for the build architecture.
- **Linux:** the Tauri v2 GTK/WebKitGTK development packages for the distribution, plus the Rust target.

Tauri builds native installers for the host OS; producing Windows, macOS, and Linux packages requires building on each respective platform.

## Using the library

The home page shows a snapshot of the first ten items in itch.io's **Popular** sort for its Ren'Py collection. Open a title's itch.io page from its details when Redline has no verified direct desktop archive. When a creator provides a public direct archive URL in the catalog, the Download action asks for an install folder and whether to launch after install; Downloads supports pause, resume, cancel, progress, and retry. ZIP extraction rejects traversal paths and symbolic links and only marks an install ready when it finds a launcher for the current OS. The Library page can launch and stop installed games.

Many itch.io games do not expose a stable, public direct archive URL in their listing. The initial ten entries therefore use `download_url: null` rather than fabricating a URL or bypassing itch.io's access/payment controls. For those entries the app opens the creator's itch.io page; the in-app resumable transfer manager is available for catalog entries whose public archive URL has been verified. `Remember` is confirmed by itch.io as browser-only, so it is labeled accordingly and is not offered as a desktop install.

## Catalog provenance

Seed order follows the itch.io `made-with-renpy` **Popular** listing captured on September 30, 2026. This is a snapshot of the site's displayed sort order, not a claimed ranking by sales, downloads, or rating. Cover images are hotlinked from the public itch.io image CDN at the 315×250 listing-thumbnail size; game pages remain the source of truth for availability, platform support, pricing, and creator information. Catalog source data is in `src-tauri/src/catalog.json`.

## Security and platform behavior

The app requests only native folder selection and external URL opening from Tauri plugins. Game launch uses a selected install's recorded executable directly (not a shell command); extracted links and paths are validated. Stop terminates the launched process and, on Unix, its dedicated process group; on Windows it terminates the launched process. Download requests are restricted to HTTPS itch.io/itch.zone hosts, and the SQLite database remains local to the user profile.
