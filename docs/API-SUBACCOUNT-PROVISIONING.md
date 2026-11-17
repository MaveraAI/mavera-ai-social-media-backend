# Sub-account provisioning API

Creates a user, their sub-account with the default plan, and the brand profile in one request, so another platform can onboard customers without the sign-up screens.

## Endpoint

```
POST https://api.mavera.ai/api/public/v1/subaccounts/create
```

Locally: `http://localhost:3000/api/public/v1/subaccounts/create`

## Headers

| Header | Required | Value |
|---|---|---|
| `Authorization` | Yes | `Bearer <PROVISIONING_API_SECRET>` |
| `Content-Type` | Yes | `application/json` |
| `Idempotency-Key` | Recommended | Any unique string per new customer, e.g. your own customer ID. Repeating a request with the same key and body returns the first result instead of creating a second account. |

## Request body

```json
{
  "user_name": "John Doe",
  "email": "john@example.com",
  "brand_name": "John's Clothing Brand"
}
```

| Field | Required | Rules |
|---|---|---|
| `user_name` | Yes | 1–120 characters |
| `email` | Yes | Valid email; stored in lowercase |
| `brand_name` | Yes | 1–120 characters, with at least 2 letters or numbers |
| `client_id` | No | Permanent brand ID: 2–50 lowercase letters, numbers or dashes. Generated from `brand_name` when omitted (`John's Clothing Brand` → `john-s-clothing-brand`), the same rule as the brand form. |
| `timezone` | No | IANA timezone, e.g. `Europe/London` (the default) |

## What gets created

1. **User**: the email is marked confirmed and given an unusable random password.
2. **Sub-account** in the agency, with the **default plan** (see Configuration).
3. **Membership**: the user is the sub-account's **administrator**, so they can edit their brand, connect GHL and invite colleagues.
4. **Brand profile** in the content service, with the same defaults as the brand form (Instagram and Facebook, British English, 4:5 images).
5. **"Set your password" email** with a secure link (valid for 1 hour; afterwards the user can use "Forgot password?" on the log in page).

Steps 1–3 run in one database transaction. If step 4 fails, steps 1–3 are undone, so a failed request never leaves a half-created account.

## Responses

**201 Created**
```json
{
  "success": true,
  "message": "Sub-account created successfully",
  "data": {
    "user_id": "6f1c2a4e-1b2c-4d5e-8f90-1234567890ab",
    "account_id": "0b7d9c3e-2f4a-4b6c-9d8e-abcdef123456",
    "client_id": "john-s-clothing-brand",
    "brand_name": "John's Clothing Brand",
    "plan": "default",
    "monthly_video_limit": 10,
    "monthly_image_limit": 30,
    "password_setup_email_sent": true
  }
}
```

| Status | When | Example message |
|---|---|---|
| 400 | Invalid or missing fields (an `errors` list says which) | `Invalid request body` |
| 401 | Missing or wrong token | `Unauthorized: Invalid API token` |
| 405 | Not a POST | `Use POST` |
| 409 | Email already has an account | `An account already exists for this email` |
| 409 | Brand ID already used | `A sub-account already exists for this brand. Use a different brand_name or client_id.` |
| 409 | Same `Idempotency-Key` still being processed | `A request with this Idempotency-Key is still being processed. Retry shortly.` |
| 413 | Body over 10 KB | `Request body is too large` |
| 415 | Not JSON | `Content-Type must be application/json` |
| 422 | `Idempotency-Key` reused with a different body | `This Idempotency-Key was already used with a different request body` |
| 429 | Over the rate limit (see `Retry-After` header) | `Too many requests. Please retry later.` |
| 502 | Brand profile couldn't be created (nothing was created) | `Could not create the brand profile. Nothing was created; please retry.` |
| 503 | `PROVISIONING_API_SECRET` not set on the server | `This API is not configured yet` |

All responses use `{ "success": false, "message": "..." }` for errors.

## Example (cURL)

```bash
curl -X POST "https://api.mavera.ai/api/public/v1/subaccounts/create" \
  -H "Authorization: Bearer $PROVISIONING_API_SECRET" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: customer-12345" \
  -d '{"user_name":"John Doe","email":"john@example.com","brand_name":"John'"'"'s Clothing Brand"}'
```

In Postman: method **POST**, the URL above, **Authorization → Bearer Token** with the secret, **Body → raw → JSON** with the payload.

## Configuration (environment variables)

| Variable | Required | Purpose |
|---|---|---|
| `PROVISIONING_API_SECRET` | Yes | The Bearer token (at least 32 characters). Generate with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. |
| `PROVISIONING_API_SECRET_PREVIOUS` | No | Old secret still accepted while you rotate to a new one. Remove it once callers are updated. |
| `DEFAULT_MONTHLY_VIDEO_LIMIT` | No | Monthly video allowance every new sub-account receives (default `10`). Used by this API **and** by sub-accounts created in the app, so both always match. |
| `DEFAULT_MONTHLY_IMAGE_LIMIT` | No | Monthly image allowance every new sub-account receives (default `30`). |
| `DEFAULT_PLAN_NAME` | No | Plan name returned in responses (default `default`). |
| `PROVISIONING_AGENCY_ID` | No | Agency that owns new sub-accounts. Not needed while there is exactly one agency. |
| `PROVISIONING_RATE_LIMIT_PER_MINUTE` | No | Requests per minute per caller IP (default `20`). Applies before the token check. |
| `BETTER_AUTH_URL` | Yes | This API's public address (e.g. `https://api.mavera.ai`), used in email links. |
| `FRONTEND_URL` | Yes | The app's address (e.g. `https://app.mavera.ai`); the "set your password" link sends users back there. |
| `RESEND_API_KEY`, `MAIL_FROM` | For emails | Without them the setup email is not sent (`password_setup_email_sent: false`). |

Never commit these values. Set them in `.env` locally and in your hosting provider's environment settings.

## Security

- The token is compared in constant time; it never appears in responses or logs.
- Logs show only a masked email (`j***@example.com`) and the new IDs.
- Rate limiting and idempotency records are stored in MongoDB (`api_rate_limits`, `api_idempotency`) and expire automatically.
