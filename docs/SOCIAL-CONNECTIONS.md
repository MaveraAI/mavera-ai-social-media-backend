# Social media connections

n8n does all the GoHighLevel (GHL) work. Users never see GHL, tokens, sub-accounts, Location IDs or User IDs.

1. **Brand saved:** `POST sm/brands` without any GHL fields. A few seconds later n8n assigns the brand a GHL sub-account and user and sets `ghl_status`:
   - empty: still being set up. The app shows "Setting up social publishing..." and polls `GET /v1/brands` every 3 seconds (for about 30 seconds).
   - `ready`: the Connect buttons are enabled.
   - `failed`: the app shows `ghl_error` and a **Retry** button (`POST /v1/brands/:clientId/connect/retry`, which saves the brand again).
2. **Connect** (brand admins and agency admins):
   1. The popup opens first, then `GET /v1/brands/:clientId/connect/start?platform=facebook` returns the platform login URL.
   2. GHL's popup posts `{ page: "social_media_posting", accountId }` back to the app.
   3. `GET /v1/brands/:clientId/connect/accounts?platform=&account_id=` lists the pages and profiles.
   4. `POST /v1/brands/:clientId/connect/attach` connects the picked ones (sent back unchanged, including `raw`).
3. **Connected accounts** live on the brand as `ghl_accounts`. Only `enabled: true` ones receive posts. There is no disconnect yet: turning an account off uses `POST /v1/brands/:clientId/connect/enabled`.

Every route checks the signed-in user's access to the brand before calling n8n with `SM_API_SECRET`. The n8n API trusts the `client_id` it is sent, so this check is what keeps brands apart.

Platforms: `facebook`, `instagram`, `linkedin`, `tiktok`, `youtube`, `google_business`, `threads`, `pinterest`.

Source: *Social Media Connect: Frontend Guide* (17 November 2026). Test page: https://mavera.app.n8n.cloud/webhook/sm/app
