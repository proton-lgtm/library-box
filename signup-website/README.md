# Playmart waitlist website

Standalone Next.js/TypeScript app for collecting **email waitlist signups only**. No passwords, Auth accounts, verification emails, analytics, mailing integration, or admin dashboard. The Electron app and its dependencies are independent.

## Interactive preview

The landing page uses self-hosted Inter, a centered heading, short subheading and compact email/Join form above a working desktop preview. Consent and Turnstile verification remain below the signup row.

The preview is entirely local: browse/search mock games, open Details, start a simulated download, pause/resume/cancel it, and find completed games in Library. One sample game is preinstalled so mods can be tried immediately. Select **Mods → Apply mods** to open Downloads and watch the simulated mod installation. Applied mods are marked after completion; cancelling never installs anything. Reloading the browser restores the initial sample state. No preview action calls the signup API, Electron IPC, downloads a file, launches a game or saves anything to Supabase/localStorage.

The demo keeps its fixed height without internal scrolling. Catalog card sizes and gaps are preserved, with overflow clipped rather than resized or paginated. On narrow screens, navigation moves to a top row and signup controls stack. Decorative preview labels and both footers are intentionally omitted. All actions are real keyboard-accessible controls; mod selection uses a focus-trapped dialog and backdrop contained within the app preview, with focus return on close.

## Local development

Use Node.js 22.18+ (Node 24 recommended) and npm. From the repository root:

```powershell
Set-Location signup-website
npm ci
Copy-Item .env.example .env.local
npm run dev
```

Open http://localhost:3000. The page runs without credentials, but submission remains disabled until a privacy policy and Turnstile site key are configured. Real submissions also require all server-side settings below. The root Electron `.env.local` is not used by this standalone app. Do not copy its secrets into this project.

## Supabase

1. Select the Supabase project you want to use. Either use the existing project's database or create a separate project manually for the waitlist.
2. Run [`20261111220000_waitlist_signups.sql`](../supabase/migrations/20261111220000_waitlist_signups.sql) in that project's SQL editor. A separate waitlist project needs only this migration, not the game catalog migrations. If using Supabase CLI migration tooling on the existing project, follow its normal pending migration workflow instead.
3. Set `SUPABASE_URL` and a **server-only** secret key in the website's environment. A modern `sb_secret_` key or the legacy service-role key is supported. A publishable/anonymous key is intentionally insufficient.

The dedicated `public.waitlist_signups` table stores a UUID, normalized unique email, consent timestamp and creation timestamp. RLS is enabled; `anon` and `authenticated` cannot read or write it. The server role receives column-level insert permissions only on this table. Secret/service-role keys still have powerful access to other tables in their project: use a separate project when stronger isolation is required. Do not broaden access by adding public policies. This app has no list/export endpoint.

## Environment variables

Copy only placeholders from [`.env.example`](.env.example), then provide real values locally or in Vercel's Environment Variables settings.

| Variable | Visibility | Purpose |
|---|---|---|
| `SUPABASE_URL` | Server | Supabase project origin |
| `SUPABASE_SECRET_KEY` | **Server secret** | Modern secret key or legacy service-role key |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Public | Cloudflare Turnstile widget site key; included at build time |
| `TURNSTILE_SECRET_KEY` | **Server secret** | Turnstile verification secret |
| `TURNSTILE_EXPECTED_HOSTNAMES` | Server | Comma-separated exact allowed hostnames, e.g. `localhost,playmart.example` |
| `PRIVACY_POLICY_URL` | Public URL, server configured | HTTPS URL of your real privacy policy |

Use your operator's actual privacy policy. It should identify the operator, purpose, retention period, contact/deletion process, and processors (including Supabase, Cloudflare and Vercel). The checkbox only grants launch/waitlist-email consent; it is not a substitute for legal review or a published policy. No legal text or operator identity is invented by the app. Delete/export records manually in Supabase as needed and establish your own retention process.

## Cloudflare Turnstile

Create a Turnstile widget in Cloudflare and allow your site's actual domain and any development hostname you intend to use. Set its public and secret keys, and set the same hostnames in `TURNSTILE_EXPECTED_HOSTNAMES` (no scheme, port or wildcard). The widget submits action `waitlist`; the server verifies both the action and hostname. Missing configuration fails closed. No production bypass is provided.

Cloudflare's official test keys may be used for local testing only. Siteverify test responses can use synthetic action/hostname values; do not relax production validation to accommodate them. The automated API tests mock provider responses with the required action/hostname. For a real local end-to-end test, use a real widget authorized for `localhost`. Use mock network responses for UI smoke tests to avoid polluting the database. Do not put emails or tokens in logs or screenshots.

Turnstile and the honeypot reduce automated abuse; neither is a durable rate limiter. Configure Vercel Firewall/rate-limit rules for `/api/waitlist` appropriate to your plan and traffic before public launch. The app deliberately does not pretend an in-memory counter works across serverless instances.

## Manual Vercel deployment

No infrastructure has been provisioned or deployed automatically.

1. Import this Git repository into Vercel.
2. Set **Root Directory** to `signup-website` and select **Next.js**.
3. Use the default install/build commands (`npm ci` / `npm run build`) and Next.js output settings. Use Node 24 or another supported 22.18+ runtime.
4. Apply the migration and configure all six variables for the target environment. Never prefix either secret with `NEXT_PUBLIC_`.
5. Add the deployed domain to the Turnstile widget and `TURNSTILE_EXPECTED_HOSTNAMES`. Configure Preview deployments separately; use exact trusted preview hostnames or disable signup for previews rather than allowing arbitrary hosts.
6. Deploy. When changing the public site key, rebuild the app. Verify the policy link and successful submissions before sharing publicly.

No additional `vercel.json` is required. Keep the form and `/api/waitlist` on the same origin.

## Submission behavior

`POST /api/waitlist`, JSON body up to 4 KiB:

```json
{
  "email": "player@example.com",
  "consent": true,
  "website": "",
  "turnstileToken": "TOKEN_FROM_WIDGET"
}
```

A matching browser `Origin` header is required. Emails are trimmed and lowercased without altering plus-addressing or dots. A new signup and an existing email both return `200 {"success":true}`; duplicates do not change the original timestamps. A filled honeypot receives the same response but is not saved. Invalid inputs/challenges are rejected, provider/configuration errors return a generic `503`, and all responses disable caching. Challenge tokens and IP addresses are never stored in the waitlist table. The widget resets after each attempt, errors retain the email, and there is no password or email delivery flow.

## Validation

```powershell
npm test
npm run lint
npm run typecheck
npm run build
```

Manual smoke checks:
- Desktop and 375px mobile: no horizontal overflow, readable preview/form, keyboard-visible focus, correct labels.
- Missing public configuration: signup disabled with a setup message.
- Valid challenge + explicit consent: loading state, then generic success.
- Duplicate email: identical success; no duplicate row or changed consent timestamp.
- Invalid/expired challenge or network error: error message; email and consent retained; fresh challenge required.
- Supabase permissions: public/anonymous roles cannot query the signup table.

Do not run real provider submissions in automated tests. Website tests use the `.node.ts` suffix so the parent Electron Vitest runner does not discover them. The migration has not been applied by this repository change.

At validation time, `npm audit --omit=dev` reports no production vulnerabilities. The generated ESLint/TypeScript-ESLint tooling has seven moderate transitive audit findings involving minimatch; `npm audit fix` currently leaves them unresolved. Recheck tooling updates before deployment; no forced or incompatible overrides were applied.
