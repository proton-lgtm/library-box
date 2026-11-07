# Supabase Integration: Approach and Decisions

## 1. Goal and boundaries

The desktop app uses Supabase as the shared source of game catalog data and for account identity. Electron's local SQLite database remains in place for offline catalog caching and device-specific operational data.

Included:

- Public catalog content available only after Supabase Auth issues a JWT.
- Anonymous sessions for browsing without initially creating an email account.
- Upgrading an anonymous session to email/password while keeping its Supabase user ID.
- Existing account sign-in and sign-out.
- Local cache, offline/stale status, and safe integration with existing installations.

Not included:

- Syncing download progress, install paths, launch state, or user preferences between devices.
- A user profile table in Postgres; Supabase Auth stores the identity.
- Automatic destructive migration/import of the legacy JSON catalog. Catalog updates are made in Supabase SQL Editor or Table Editor.

## 2. Supabase relational model

### `public.games`

One row per game:

- `id`: generated UUID primary key. This is the stable catalog identity.
- `name`: required, unique, non-empty title.
- `thumbnail_url`: HTTPS URL or empty string.
- `size_bytes`: optional non-negative byte count.
- `last_updated`: optional content-update timestamp.
- `tags`: text array, default empty.
- `created_at`, `updated_at`: row-maintenance timestamps. `updated_at` is maintained by a trigger and is distinct from the content's `last_updated`.

### `public.game_details`

One optional one-to-one detail row, linked by `game_id` to `games.id`:

- `description`, `release_date`, `last_updated`, `version`.
- `developer_links`: JSON object keyed by provider, such as `website` or `patreon`.
- `operating_systems`: text array.
- `download_links`: JSON object keyed by download provider.
- `mod_links`: JSON array of mods. Each mod stores its name, provider links, and the `steps_to_apply` structure used by the existing installer.
- `created_at`, `updated_at`: row-maintenance timestamps.

Deleting a game cascades to its detail row. Table checks enforce expected JSON object/array shapes, non-negative size, and HTTPS thumbnail URLs. The app validates catalog responses and HTTPS links before using them.

## 3. Database access control

Both tables have Row Level Security enabled:

- `authenticated` can `SELECT` catalog rows.
- `anon` has no table privileges or read policy.
- `authenticated` has no client-side write privileges; catalog edits are performed in the Supabase dashboard or a privileged administrative workflow, never from the desktop app.

An anonymous Supabase Auth user is still an authenticated Postgres-role user: its JWT carries the `authenticated` role and an `is_anonymous` claim. The app first creates or restores that Auth session, then queries the tables using the Supabase client, which attaches the JWT. If authentication fails, no catalog query is made; cached games may still be displayed as stale/offline.

Apply migrations in timestamp order. `20261105000000_catalog.sql` creates the schema; `20261105143500_authenticated_catalog_access.sql` tightens existing table access for projects that applied the earlier catalog migration. The base migration also reflects the tightened policy for fresh projects.

## 4. Authentication lifecycle

1. On startup, initialize Supabase Auth in the Electron main process.
2. Restore the session from encrypted OS-backed storage, if available.
3. If there is no session, call anonymous sign-in and store the resulting session securely.
4. The user can open Profile to:
   - Upgrade the current anonymous account in place with email and password.
   - Sign in to an existing email/password account.
   - Sign out; signing out starts a new anonymous session when the network allows.
5. Account upgrade uses Supabase `updateUser` on the current session, not a second account creation, preserving the Auth user ID and any future data ownership.

Supabase Auth dashboard setup: enable new-user signup and anonymous sign-ins; enable manual identity linking; keep email confirmation disabled to avoid requiring email verification. With confirmations disabled, Supabase treats the email as confirmed; the app checks this before setting the password. If dashboard settings differ, the app reports the error rather than showing a successful upgrade.

The publishable key is public configuration, not an authorization secret. It can be bundled into the application; database access relies on the JWT and RLS. A service-role key must never be embedded or distributed.

## 5. Secure session persistence and process boundaries

- The Supabase client and Auth session live in Electron main, not the renderer.
- Session JSON is encrypted asynchronously with Electron `safeStorage` and written atomically to the app's per-user data directory.
- If OS encryption is unavailable or Linux selects `basic_text`, persistent sign-in is disabled rather than saving tokens in plaintext. An ephemeral in-memory session can still support authenticated catalog browsing until the app exits.
- Renderer calls cross a narrow typed preload API and validated IPC. Passwords are accepted only for the specific auth operations; generic IPC, direct Supabase clients, and session tokens are not exposed.
- External developer/download URLs are checked for public HTTPS before opening; catalog-provided links and mod-step shapes are validated before use.

## 6. Catalog synchronization and SQLite compatibility

Supabase is the authoritative catalog. SQLite is retained for:

- A last-known catalog snapshot so Home can still render when Supabase is unavailable.
- Download lifecycle, archive paths, install directories, selected mod IDs, and launch/library state on this machine.

Each successful refresh fetches `games` with the nested `game_details` relation and upserts the result into SQLite. A local `supabase_id` UUID column provides stable catalog identity while the existing integer SQLite `id` remains the app-facing key for downloads and installed-game records. On first sync, a matching legacy row can be associated by name so an existing install is not orphaned. Rows absent from the latest remote snapshot are hidden from the catalog, but local download/install rows are retained.

Remote refresh failures do not replace the cache. The renderer shows the cached games with a stale/offline indication and allows a retry. Successful sync updates a local `last_synced_at` value.

The runtime no longer seeds the desktop app from `py_box/games.json`. The Python CLI and its JSON catalog remain independent. Missing metadata in Supabase remains empty/optional; the UI renders fields only when available.

## 7. UI behavior

- The profile control reflects anonymous, signed-in, or unavailable auth state.
- Profile supports account creation/upgrade, existing-account sign-in, and sign-out.
- Home cards can show tags.
- Game detail pages can show description, size, version, content/release dates, supported operating systems, tags, developer links, download providers, and available mods.
- Existing download destination selection, auto-run, mod selection, archive retention/reuse, downloads controls, and local launch/stop/delete behavior remain local and unchanged by catalog synchronization.

## 8. Configuration and operations

Development configuration is loaded from ignored `.env.local`:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`

The build embeds only these public values so installed packages do not depend on a developer's `.env.local`. Never commit `.env.local`; never use a service-role key.

For catalog data, apply migrations in the Supabase SQL Editor. Game rows and matching detail rows can then be added with SQL or Table Editor. The legacy `games.json` entries are not imported automatically; when requested, paste-ready SQL may be provided for the existing records.

## 9. Validation strategy

The implementation is checked with:

- SQLite tests for catalog sync, stable local IDs, cache retention, and schema migration that preserves installed game records.
- Supabase-service tests for nested response mapping, stale/offline fallback, Auth lifecycle, JWT establishment before catalog queries, and session-storage encryption behavior.
- IPC validation tests for credentials and external HTTPS links.
- Renderer tests for account actions and stale-catalog retry UI.
- `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`.

Live Supabase SQL migrations and real network/Auth flows require validation against the configured project; unit tests mock the Supabase client and do not claim to verify remote dashboard configuration.

## 10. Resetting local Electron storage

`npm run clear:electron-storage` launches a small Electron main-process script to obtain the exact runtime `app.getPath("userData")` path across Windows, macOS, and Linux. It prints the target and requires typing `CLEAR` before removing the contents. Passing `-- --yes` bypasses the prompt for deliberate scripted use; `-- --dry-run` prints without deleting.

The reset removes the local SQLite database and its WAL/SHM files, encrypted Supabase session, and Chromium cache/storage. It does **not** remove installed game folders, which are selected and stored outside Electron's user-data directory. Close the regular app before performing a reset.
