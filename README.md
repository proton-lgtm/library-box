# Playmart

A cross-platform desktop game library for browsing, downloading, installing, and launching games. Browse your cached catalog offline, manage downloads and mods, and keep your installed collection in one place.

## Downloads

Download published packages from [GitHub Releases](https://github.com/proton-lgtm/library-box/releases), starting with [v0.1.3](https://github.com/proton-lgtm/library-box/releases/tag/v0.1.3). The independent [download website](./signup-website/README.md) links to available release assets instead of collecting waitlist registrations.

Native release builds target Windows x64 (installer and portable), Linux x64 (AppImage and Debian package), and macOS Intel/Apple Silicon (DMG). Only packages actually published to a release are available to download; v0.1.3 currently contains Windows packages only. Games must themselves be compatible with the host OS.

Updater-enabled installed Windows, macOS, and Linux AppImage builds check GitHub Releases at startup and every six hours, download stable updates automatically, and ask before restarting to install. Choosing **Later** does not install on exit. Portable Windows and Debian packages offer a manual release download instead. Existing v0.1.3 binaries cannot gain an updater retroactively: install a newer updater-enabled release manually first. macOS updates require signed builds; see [release requirements](./DEVELOPMENT.md#automatic-updates).

## Development

See [DEVELOPMENT.md](./DEVELOPMENT.md) for setup, architecture, testing, packaging, releases, and backend configuration.

## Using the library

Home shows the games fetched from Supabase; the last cached catalog remains available when the service is offline. Selecting a cover opens details and the download flow. Choose an existing destination folder, optionally select catalog mods, and optionally enable auto-run after installation. The game archive and selected mod files are kept in the game folder alongside extracted files. When retrying an install, existing game and mod archives are reused rather than downloaded again. Downloads are available from the left navigation and support pause, resume, and cancel. GoFile and Workupload links open in a dedicated browser window so the user can complete any host-page interaction. Other configured HTTPS links are downloaded directly. The Library page lists installed games and lets the user launch, stop, or delete them. Deletion removes the installed folder, including its kept archives. Missing install folders are reconciled during refresh and removed from the library.

### Refreshing pages and restoring unmodified games

Every main page has a **Reload page** control. Home and Game Details refetch the catalog from Supabase. Downloads and Library reverify local installation folders and required game content, removing stale local records without deleting game files. Active work is protected during verification.

Archive extraction has its own progress indicator for both games and mods. When the extractor cannot report progress, an indeterminate indicator is shown instead of a misleading completed download percentage.

Open **Library → More options → Mods → Remove all mods** to restore a game's original files. The confirmation explains that all other files in the installation folder—including locally stored saves—are removed, while the original game archive is preserved and re-extracted. Back up saves and close the game first. Archive verification occurs before removal; missing or invalid archives leave the installation unchanged. The dialog shows restoration progress, success, or a retryable error, and clears applied mod selections only after successful restoration.

