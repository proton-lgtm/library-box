# Playmart

A cross-platform desktop game library for browsing, downloading, installing, and launching games. Browse your cached catalog offline, manage downloads and mods, and keep your installed collection in one place.

## Email waitlist website

The independent [signup website](./signup-website/README.md) is a Vercel-ready Next.js app that collects email waitlist registrations in Supabase with consent and Turnstile verification. See its README for local development, database migration and manual deployment instructions. It does not create user accounts or change the Electron app.

## Development

See [DEVELOPMENT.md](./DEVELOPMENT.md) for setup, architecture, testing, packaging, releases, and backend configuration.

## Using the library

Home shows the games fetched from Supabase; the last cached catalog remains available when the service is offline. Selecting a cover opens details and the download flow. Choose an existing destination folder, optionally select catalog mods, and optionally enable auto-run after installation. The game archive and selected mod files are kept in the game folder alongside extracted files. When retrying an install, existing game and mod archives are reused rather than downloaded again. Downloads are available from the left navigation and support pause, resume, and cancel. GoFile and Workupload links open in a dedicated browser window so the user can complete any host-page interaction. Other configured HTTPS links are downloaded directly. The Library page lists installed games and lets the user launch, stop, or delete them. Deletion removes the installed folder, including its kept archives. Missing install folders are reconciled during refresh and removed from the library.

### Refreshing pages and restoring unmodified games

Every main page has a **Reload page** control. Home and Game Details refetch the catalog from Supabase. Downloads and Library reverify local installation folders and required game content, removing stale local records without deleting game files. Active work is protected during verification.

Archive extraction has its own progress indicator for both games and mods. When the extractor cannot report progress, an indeterminate indicator is shown instead of a misleading completed download percentage.

Open **Library → More options → Mods → Remove all mods** to restore a game's original files. The confirmation explains that all other files in the installation folder—including locally stored saves—are removed, while the original game archive is preserved and re-extracted. Back up saves and close the game first. Archive verification occurs before removal; missing or invalid archives leave the installation unchanged. The dialog shows restoration progress, success, or a retryable error, and clears applied mod selections only after successful restoration.

