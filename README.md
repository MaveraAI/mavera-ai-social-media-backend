# Mavera AI: Social Media Backend

REST API for the Mavera AI social media content manager. The frontend (Cloudflare Pages) calls it from the browser; other platforms call the provisioning API server-to-server.

- **Runtime:** Node.js 22+ with [Hono](https://hono.dev)
- **Database:** MongoDB Atlas
- **Login:** Better Auth (email and password, httpOnly session cookie)
- **Content:** n8n content API (brands, campaigns, publishing to GHL)
- **Hosting:** Railway

## Run locally

```bash
npm install
cp .env.example .env     # then fill in the values
npm run dev              # http://localhost:3000
```

With the frontend running on `http://localhost:8080`, set `FRONTEND_URL=http://localhost:8080` and `BETTER_AUTH_URL=http://localhost:3000`.

| Command | What it does |
|---|---|
| `npm run dev` | Start with auto-reload |
| `npm run build` | Bundle to `dist/index.js` |
| `npm start` | Run the built server |
| `npm test` | Unit tests |
| `npm run typecheck` | TypeScript check |
| `npm run import:lovable -- <data.sql> [--dry-run]` | Import the old Lovable/Supabase backup into MongoDB |

## API

All `/v1` routes need a signed-in user (session cookie). Changes must come from a `FRONTEND_URL` origin.

| Method | Path | Purpose |
|---|---|---|
| GET/POST | `/api/auth/*` | Better Auth: sign up, sign in, sign out, session, email confirmation, password reset |
| GET | `/v1/accounts` | Sub-accounts the user can see, agency admin flag, roles |
| GET | `/v1/accounts/:accountId/usage` | This month's video and image usage and allowances |
| PUT | `/v1/accounts/:accountId/video-limit` | Set the monthly video (`limit`) and image (`image_limit`) allowances (agency admins) |
| GET | `/v1/accounts/:accountId/people` | Members and invitations (sub-account admins) |
| POST | `/v1/accounts/:accountId/members/:userId` | Change a member: `admin`, `member`, `remove`, `restore` |
| POST | `/v1/accounts/:accountId/invitations` | Invite by email |
| DELETE | `/v1/accounts/:accountId/invitations/:invitationId` | Revoke an invitation |
| POST | `/v1/invitations/inspect` | Check an invitation token |
| POST | `/v1/invitations/accept` | Accept an invitation |
| GET | `/v1/brands?client_id=` | Brand profiles |
| POST | `/v1/brands` | Create or update a brand |
| POST | `/v1/brands/import` | Import existing n8n brands (agency admins) |
| GET | `/v1/brands/:clientId/ghl-accounts` | Load connected social accounts |
| GET | `/v1/jobs?client_id=` | Campaigns for a brand |
| GET | `/v1/jobs/:jobId` | Campaign with posts |
| POST | `/v1/jobs` | Start a campaign (reserves monthly videos) |
| POST | `/v1/brands/:clientId/references` | Upload a reference image or PDF (max 10 MB) for the next campaign; send the returned files as `references` on `POST /v1/jobs` (max 5) |
| POST | `/v1/publish` | Approve and schedule posts in GHL |
| POST | `/v1/posts/:postId/revise` | Edit (`{mode:"edit", instruction}`) or regenerate (`{mode:"regenerate"}`) a post; video changes use 1 video from the monthly allowance |
| POST | `/v1/posts/:postId/version` | Switch a post to an earlier version (`{version_id}`); publishing uses it |
| GET | `/v1/brands/:clientId/connect/start?platform=` | Platform login address for the Connect popup (n8n) |
| GET | `/v1/brands/:clientId/connect/accounts?platform=&account_id=` | Pages and profiles from that login |
| POST | `/v1/brands/:clientId/connect/attach` | Connect the picked pages (`{platform, account_id, accounts}`) |
| POST | `/v1/brands/:clientId/connect/enabled` | Turn connected accounts on or off for posting (`{accounts:[{id, enabled}]}`) |
| POST | `/v1/brands/:clientId/connect/retry` | Re-run n8n's brand setup after `ghl_status: "failed"` |
| POST | `/api/public/v1/subaccounts/create` | Provisioning API (Bearer secret), see [docs](docs/API-SUBACCOUNT-PROVISIONING.md) |
| GET | `/health` | Health and database check |

Errors are `{ "message": "..." }` with a matching status code.

## Deploy on Railway

1. **New Project → Deploy from GitHub repo →** `MaveraAI/mavera-ai-social-media-backend`.
2. Build and start commands come from `railway.json` (Railway installs packages, then `npm run build` and `npm start`, health check `/health`).
3. **Variables:** add everything from `.env.example`:
   - `FRONTEND_URL=https://app.mavera.ai`
   - `BETTER_AUTH_URL=https://api.mavera.ai`
   - `BETTER_AUTH_SECRET`, `MONGODB_URI`, `MONGODB_DB`, `SM_API_SECRET`, `PROVISIONING_API_SECRET`, `DEFAULT_MONTHLY_VIDEO_LIMIT` (10), `DEFAULT_MONTHLY_IMAGE_LIMIT` (30), `RESEND_API_KEY`, `MAIL_FROM`
   - Railway sets `PORT` itself.
4. **Settings → Region:** Europe West (close to the MongoDB cluster in Ireland).
5. **Settings → Networking → Custom Domain:** `api.mavera.ai`. Add the CNAME Railway shows in Cloudflare DNS (proxy off, grey cloud, or SSL mode Full (strict) if proxied).
6. **MongoDB Atlas → Network Access:** allow `0.0.0.0/0` (Railway has no fixed IP addresses).
7. Check `https://api.mavera.ai/health` returns `{"ok":true,"database":"connected"}`.

## Security notes

- CORS and an Origin check only allow browsers on `FRONTEND_URL`; the session cookie is httpOnly.
- `app.mavera.ai` and `api.mavera.ai` share a site, so cookies use `SameSite=Lax`. Only set `COOKIE_SAMESITE=none` when testing on unrelated domains (e.g. `*.pages.dev` with `*.up.railway.app`).
- MongoDB has no row-level security: every route authorizes through `src/lib/mavera/tenant.server.ts`.
- Secrets live in Railway variables and local `.env` only, never in git.
