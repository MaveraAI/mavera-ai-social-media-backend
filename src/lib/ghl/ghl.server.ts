// Server-only client for the GHL (HighLevel / LeadConnector) API, used to connect social accounts
// without users ever seeing a Location ID or token. Docs: https://marketplace.gohighlevel.com/docs
const API = 'https://services.leadconnectorhq.com';
const VERSION = '2021-07-28';

/** Scopes the Mavera Marketplace app must request (also listed in docs/SOCIAL-CONNECTIONS.md). */
export const GHL_SCOPES = [
  'oauth.readonly', 'oauth.write', 'locations.readonly', 'users.readonly',
  'socialplanner/oauth.readonly', 'socialplanner/oauth.write',
  'socialplanner/account.readonly', 'socialplanner/account.write',
  'socialplanner/post.readonly', 'socialplanner/post.write',
] as const;

/** The Marketplace app settings, or null while the app is not set up. */
export function ghlApp() {
  const id = process.env['GHL_CLIENT_ID'];
  const secret = process.env['GHL_CLIENT_SECRET'];
  if (!id || !secret) return null;
  const apiUrl = (process.env['BETTER_AUTH_URL'] || `http://localhost:${process.env['PORT'] || 3000}`).replace(/\/$/, '');
  return {
    id, secret,
    redirectUri: process.env['GHL_REDIRECT_URI'] || `${apiUrl}/oauth/ghl/callback`,
    installUrl: process.env['GHL_INSTALL_URL'] || 'https://marketplace.gohighlevel.com/oauth/chooselocation',
  };
}

export class GhlError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = 'GhlError'; }
}

/** Short, user-safe reason from a GHL error body. */
function reason(data: unknown, status: number) {
  const d = (data ?? {}) as { message?: unknown; error?: unknown; error_description?: unknown; results?: { error?: { message?: unknown } } };
  const raw = d.error_description ?? d.results?.error?.message ?? d.message ?? d.error;
  const text = Array.isArray(raw) ? raw.join('; ') : typeof raw === 'string' ? raw : '';
  return text.slice(0, 200) || `GHL error ${status}`;
}

type Init = { token?: string; method?: string; json?: unknown; form?: Record<string, string>; redirect?: 'manual' };

/** Calls GHL and returns the parsed JSON (or the raw Response for redirects). */
export async function ghlFetch<T>(path: string, init: Init = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', Version: VERSION };
  if (init.token) headers['Authorization'] = `Bearer ${init.token}`;
  let body: string | undefined;
  if (init.form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(init.form).toString(); }
  else if (init.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(init.json); }
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? (body ? 'POST' : 'GET'), headers, body: body ?? null, redirect: init.redirect ?? 'follow',
    signal: AbortSignal.timeout(30_000),
  }).catch((error: unknown) => {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw new GhlError(504, 'GHL took too long to respond. Please retry.');
    throw new GhlError(502, 'Could not reach GHL. Please retry.');
  });
  if (init.redirect === 'manual') return res as T;
  const text = await res.text();
  let data: unknown = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text.slice(0, 200) }; }
  if (!res.ok || (data as { success?: boolean })?.success === false) {
    console.error(`[ghl] ${init.method ?? (body ? 'POST' : 'GET')} ${path.split('?')[0]} [${res.status}]: ${text.slice(0, 300)}`);
    if (res.status === 401) throw new GhlError(401, 'GHL did not accept the saved connection. Reconnect GHL and try again.');
    if (res.status === 403) throw new GhlError(403, 'GHL refused this action. Check the app permissions (scopes) in GHL.');
    throw new GhlError(res.status, reason(data, res.status));
  }
  return data as T;
}

export type GhlTokenResponse = {
  access_token: string; refresh_token?: string; expires_in?: number; scope?: string;
  userType?: string; companyId?: string; locationId?: string; userId?: string;
};

/** OAuth token endpoint: install code or refresh token -> Company tokens. */
export function ghlToken(grant: { code: string } | { refresh_token: string }) {
  const app = ghlApp();
  if (!app) throw new Error('GHL is not set up on the server yet.');
  return ghlFetch<GhlTokenResponse>('/oauth/token', {
    form: {
      client_id: app.id, client_secret: app.secret, user_type: 'Company', redirect_uri: app.redirectUri,
      ...('code' in grant ? { grant_type: 'authorization_code', code: grant.code } : { grant_type: 'refresh_token', refresh_token: grant.refresh_token }),
    },
  });
}

/** A sub-account (location) token from the agency's Company token. */
export function ghlLocationToken(companyToken: string, companyId: string, locationId: string) {
  return ghlFetch<GhlTokenResponse>('/oauth/locationToken', { token: companyToken, form: { companyId, locationId } });
}

/**
 * Where to send the user to log in to a platform. GHL's start endpoint needs the token in a header,
 * so the server follows it once and hands the platform's own login address to the popup.
 */
export async function ghlStartUrl(token: string, platform: string, locationId: string, userId: string, reconnect = false) {
  const q = new URLSearchParams({ locationId, userId, ...(reconnect ? { reconnect: 'true' } : {}) });
  const res = await ghlFetch<Response>(`/social-media-posting/oauth/${platform}/start?${q}`, { token, redirect: 'manual' });
  const location = res.headers.get('location');
  if (res.status >= 300 && res.status < 400 && location) return new URL(location, API).toString();
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(text) as Record<string, unknown>; } catch { /* not JSON */ }
  const url = [data['url'], data['redirectUrl'], (data['results'] as Record<string, unknown> | undefined)?.['url']].find((v) => typeof v === 'string');
  if (res.ok && typeof url === 'string') return url;
  console.error(`[ghl] start ${platform} [${res.status}]: ${text.slice(0, 300)}`);
  if (res.status === 401) throw new GhlError(401, 'GHL did not accept the saved connection. Reconnect GHL and try again.');
  throw new GhlError(res.status || 502, reason(data, res.status) || 'Could not start the connection. Please retry.');
}
