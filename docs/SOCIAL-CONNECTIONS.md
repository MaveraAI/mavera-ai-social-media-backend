# Social media connections (GHL behind the scenes)

Users connect Instagram, Facebook, LinkedIn, Google Business, TikTok, YouTube, Pinterest and Threads from **Your brand → Social accounts** in Mavera. They click **Connect**, log in to the platform in a pop-up, pick the page or profile, and they are done. They never open GHL or copy IDs and tokens.

Publishing is unchanged: n8n still posts through GHL. After every connect or disconnect, the backend updates the brand in n8n with the connected accounts and a fresh GHL token.

## How it works

1. **One time, agency admin:** in **Agency & sub-accounts → Connect GHL**, GHL's install page opens and the admin approves the Mavera app for the agency. The backend stores the agency (Company) tokens, encrypted, in MongoDB (`ghl_connections`).
2. **Per brand:** the agency admin picks the brand's **GHL sub-account** in the brand form and saves. The backend mints a sub-account token from the agency token and saves it into the brand in n8n.
3. **Per social account:** **Connect** → the backend asks GHL for the platform's login page → pop-up → GHL reports back to Mavera → the user picks the page or profile → the backend attaches it in GHL and ticks it for posting in n8n.
4. **Before publishing:** if the brand's sub-account token is older than about 22 hours, the backend sends n8n a fresh one first (GHL sub-account tokens last about 24 hours).

Brands without the agency app still work the old way: paste a Private Integration Token in the brand form once (it is now also kept, encrypted, on our side), and the Connect buttons work for that brand too.

## Set up the GHL Marketplace app (once)

1. Go to <https://marketplace.gohighlevel.com> → sign in with the agency's GHL login → **My Apps → Create App**.
   - **App type:** Private (only for our agency).
   - **Distribution / Target user:** **Agency** (Sub-account is not enough: we need the agency token to reach every brand).
   - **Who can install:** agency admins.
2. **Advanced Settings → Auth:**
   - **Redirect URL:** `https://<backend address>/oauth/ghl/callback`.
     - Production: `https://mavera-ai-social-media-backend-production.up.railway.app/oauth/ghl/callback` (or the custom API domain once it exists).
     - Local: `http://localhost:3000/oauth/ghl/callback`.
   - **Scopes:**
     - `oauth.readonly`, `oauth.write`
     - `locations.readonly`, `users.readonly`
     - `socialplanner/oauth.readonly`, `socialplanner/oauth.write`
     - `socialplanner/account.readonly`, `socialplanner/account.write`
     - `socialplanner/post.readonly`, `socialplanner/post.write`
   - Create a **Client ID / Client Secret** pair.
3. Add these to Railway → Variables (and your local `.env`):

   ```
   GHL_CLIENT_ID=...
   GHL_CLIENT_SECRET=...
   # Optional: only if the redirect URL is not BETTER_AUTH_URL + /oauth/ghl/callback
   # GHL_REDIRECT_URI=https://.../oauth/ghl/callback
   # Optional: a dedicated 32-byte key for encrypting GHL tokens (otherwise derived from BETTER_AUTH_SECRET)
   # GHL_TOKEN_KEY=   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```

4. In Mavera: **Agency & sub-accounts → Connect GHL**, choose the agency, approve. You return to Mavera with "GHL connected".
5. For each brand: **Your brand → GHL sub-account →** pick it **→ Save**. The **Social accounts** panel underneath now shows Connect buttons.

If `GHL_TOKEN_KEY` is not set, tokens are encrypted with a key derived from `BETTER_AUTH_SECRET`. Changing that secret means reconnecting GHL and re-entering any brand's private token.

## Endpoints

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/v1/ghl` | signed in | `{ app_configured, connected, agency_admin }` |
| POST | `/v1/ghl/install` | agency admin | `{ url }` of GHL's install page (one-time `state`, 10 minutes) |
| GET | `/oauth/ghl/callback` | GHL redirect | Stores the agency tokens, then returns to `/agency?ghl=connected` |
| DELETE | `/v1/ghl` | agency admin | Forget the agency tokens |
| GET | `/v1/ghl/locations` | agency admin | GHL sub-accounts to link brands to |
| GET | `/v1/brands/:clientId/connections` | brand member | `{ ready, source, reason, can_manage, accounts[] }` |
| POST | `/v1/brands/:clientId/connections/start` | brand admin | `{ platform, reconnect? }` → `{ url }` for the pop-up |
| GET | `/v1/brands/:clientId/connections/:platform/:accountId/options` | brand admin | Pages and profiles to choose from after login |
| POST | `/v1/brands/:clientId/connections/:platform/:accountId` | brand admin | `{ option_id }`: connect it and tick it for posting |
| DELETE | `/v1/brands/:clientId/connections/:id` | brand admin | Disconnect an account |

## Security

- GHL tokens never reach the browser. They are stored with AES-256-GCM, and the install `state` is single-use and stored only as a hash.
- Every brand call checks the user's access first: members can view, admins can change.
- The pop-up's message is only accepted from the window Mavera opened. Its account ID is checked again with GHL before anything is attached.

## Good to know

- GHL's platform pop-ups may show GHL's own app name ("LeadConnector") on the platform consent screen. Full Mavera branding needs Option 2 (white-label unified API) later. The Connections page stays the same; only the backend changes.
- X (Twitter) is not offered: GHL's connect API does not list it.
- TikTok Business uses a separate GHL flow and is not included yet.
