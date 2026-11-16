// Connecting social accounts from inside Mavera. The agency connects GHL once (Marketplace app);
// after that each brand gets one-click Connect buttons and the user only sees the platform's popup.
// Publishing is unchanged: n8n still posts through GHL with the brand's saved token and accounts.
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { AuthContext } from '@/http';
import type { Collections } from '@/lib/db/mongo.server';
import { primaryFrontendUrl } from '@/config';
import { GHL_SCOPES, ghlApp, ghlFetch, ghlStartUrl, ghlToken } from '@/lib/ghl/ghl.server';
import { actingUser, brandGhl, companyToken, encryptToken, hashState, n8nBrand, type BrandGhl } from '@/lib/ghl/tokens.server';
import { smRequest as sm } from '@/lib/mavera/sm-api.server';
import {
  clientIdSchema, connectPlatformSchema, ghlIdSchema, validate,
  type ConnectOption, type ConnectPlatform, type ConnectionsState, type GhlAccount, type GhlAgencyStatus, type SocialConnection,
} from '@/lib/mavera/sm-shared';
import { accountForClient, requireAgency, subAccountAccess } from '@/lib/mavera/tenant.server';

// ---------- Agency: connect GHL once ----------
async function agencyIds(db: Collections, userId: string) {
  const admin = await db.agencyMemberships.find({ user_id: userId, role: 'admin' }).toArray();
  return admin.map((a) => a.agency_id);
}

export async function agencyStatus(ctx: AuthContext): Promise<GhlAgencyStatus> {
  const agencies = await agencyIds(ctx.db, ctx.userId);
  // Sub-account admins also need to know, so their brand form hides the token fields.
  const memberships = await ctx.db.subAccountMemberships.find({ user_id: ctx.userId, revoked_at: null }).toArray();
  const memberAgencies = memberships.length
    ? (await ctx.db.subAccounts.find({ id: { $in: memberships.map((m) => m.sub_account_id) } }).toArray()).map((a) => a.agency_id) : [];
  const all = [...new Set([...agencies, ...memberAgencies])];
  const conn = all.length ? await ctx.db.ghlConnections.findOne({ agency_id: { $in: all } }) : null;
  const own = !!conn && agencies.includes(conn.agency_id);
  return {
    app_configured: !!ghlApp(), connected: !!conn, agency_admin: agencies.length > 0,
    company_id: own ? conn.company_id : null, connected_at: own ? conn.connected_at.toISOString() : null,
  };
}

/** The GHL install page for the agency admin (state is single-use and expires in 10 minutes). */
export async function agencyInstallUrl(ctx: AuthContext) {
  const agencyId = await requireAgency(ctx.db, ctx.userId);
  const app = ghlApp();
  if (!app) throw new Error('GHL is not set up on the server yet. Add GHL_CLIENT_ID and GHL_CLIENT_SECRET (see docs/SOCIAL-CONNECTIONS.md).');
  const state = randomBytes(24).toString('base64url');
  await ctx.db.ghlStates.insertOne({ state_hash: hashState(state), agency_id: agencyId, user_id: ctx.userId, expires_at: new Date(Date.now() + 10 * 60_000) });
  const q = new URLSearchParams({ response_type: 'code', client_id: app.id, redirect_uri: app.redirectUri, scope: GHL_SCOPES.join(' '), state });
  return { url: `${app.installUrl}?${q}` };
}

/** GHL redirects here after the install. Returns where to send the browser next. */
export async function completeAgencyInstall(db: Collections, code: string | undefined, state: string | undefined, error?: string) {
  const back = (status: string, reason?: string) =>
    `${primaryFrontendUrl()}/agency?ghl=${status}${reason ? `&reason=${encodeURIComponent(reason.slice(0, 160))}` : ''}`;
  if (error) return back('error', 'GHL access was not granted.');
  if (!code || !state) return back('error', 'The GHL response was incomplete. Please try again.');
  const saved = await db.ghlStates.findOneAndDelete({ state_hash: hashState(state), expires_at: { $gt: new Date() } });
  if (!saved) return back('error', 'This link expired. Start the GHL connection again.');
  try {
    const r = await ghlToken({ code });
    if (!r.companyId || !r.refresh_token) return back('error', 'Install the app for the whole agency (not a single sub-account).');
    const now = new Date();
    await db.ghlConnections.updateOne({ agency_id: saved.agency_id }, { $set: {
      company_id: r.companyId, user_id: r.userId ?? null, scope: r.scope ?? '',
      access_token_enc: encryptToken(r.access_token), refresh_token_enc: encryptToken(r.refresh_token),
      expires_at: new Date(Date.now() + (r.expires_in ?? 86_000) * 1000), connected_by: saved.user_id, connected_at: now, updated_at: now,
    } }, { upsert: true });
    // Tokens minted under an older install are no longer valid.
    await db.ghlLocationTokens.deleteMany({ agency_id: saved.agency_id });
    return back('connected');
  } catch (e) {
    console.error('[ghl] install failed', e instanceof Error ? e.message : e);
    return back('error', e instanceof Error ? e.message : 'Could not finish connecting GHL.');
  }
}

export async function disconnectAgency(ctx: AuthContext) {
  const agencyId = await requireAgency(ctx.db, ctx.userId);
  await Promise.all([ctx.db.ghlConnections.deleteOne({ agency_id: agencyId }), ctx.db.ghlLocationTokens.deleteMany({ agency_id: agencyId })]);
  return { ok: true };
}

/** GHL sub-accounts in the agency, so brands are linked by picking a name instead of typing an ID. */
export async function agencyLocations(ctx: AuthContext) {
  const agencyId = await requireAgency(ctx.db, ctx.userId);
  const { token, companyId } = await companyToken(ctx.db, agencyId);
  const all: { id: string; name: string }[] = [];
  for (let skip = 0; skip < 2000; skip += 100) {
    const r = await ghlFetch<{ locations?: { id: string; name?: string }[] }>(`/locations/search?companyId=${encodeURIComponent(companyId)}&limit=100&skip=${skip}`, { token });
    const page = r.locations ?? [];
    all.push(...page.map((l) => ({ id: l.id, name: l.name || l.id })));
    if (page.length < 100) break;
  }
  return all.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- Per brand ----------
type RawAccount = { id: string; name?: string; platform?: string; type?: string; avatar?: string | null; isExpired?: boolean; deleted?: boolean };

async function ghlAccounts(conn: BrandGhl) {
  const r = await ghlFetch<{ results?: { accounts?: RawAccount[] } }>(`/social-media-posting/${encodeURIComponent(conn.locationId)}/accounts`, { token: conn.token });
  return (r.results?.accounts ?? []).filter((a) => !a.deleted);
}
const toConnection = (a: RawAccount): SocialConnection => ({
  id: a.id, platform: a.platform ?? 'unknown', name: a.name || a.platform || 'Account', avatar: a.avatar ?? null, kind: a.type ?? null, expired: !!a.isExpired,
});

async function brandAccess(ctx: AuthContext, clientId: string, admin: boolean) {
  return accountForClient(ctx.db, ctx.userId, validate(clientIdSchema)(clientId), admin);
}

export async function brandConnections(ctx: AuthContext, clientId: string): Promise<ConnectionsState> {
  const account = await brandAccess(ctx, clientId, false);
  const canManage = await subAccountAccess(ctx.db, ctx.userId, account, true);
  let conn: BrandGhl;
  try { conn = await brandGhl(ctx.db, account.id); }
  catch (e) { return { ready: false, source: null, reason: e instanceof Error ? e.message : 'Not connected', can_manage: canManage, accounts: [] }; }
  return { ready: true, source: conn.source, reason: null, can_manage: canManage, accounts: (await ghlAccounts(conn)).map(toConnection) };
}

export async function startConnection(ctx: AuthContext, clientId: string, input: unknown) {
  const data = validate(z.object({ platform: connectPlatformSchema, reconnect: z.boolean().optional() }))(input);
  const account = await brandAccess(ctx, clientId, true);
  const conn = await brandGhl(ctx.db, account.id);
  return { url: await ghlStartUrl(conn.token, data.platform, conn.locationId, await actingUser(conn), data.reconnect) };
}

type RawOption = Record<string, unknown> & { id?: string; name?: string; avatar?: string; isConnected?: boolean };
type Choice = { option: ConnectOption; body: Record<string, unknown> };

/** Turns GHL's "pick a page/profile" answer into choices, each with the body that attaches it. */
export function choicesFor(platform: ConnectPlatform, results: Record<string, unknown>): Choice[] {
  const list = (key: string) => (Array.isArray(results[key]) ? results[key] as RawOption[] : []);
  const base = (o: RawOption, kind: string | null, id = String(o.id ?? '')) => ({ id, name: String(o.name ?? o['username'] ?? id), avatar: (o.avatar as string) ?? null, kind, connected: !!o.isConnected });
  switch (platform) {
    case 'facebook':
      return list('pages').map((o) => ({ option: base(o, 'page'), body: { type: 'page', originId: o.id, name: o.name, avatar: o.avatar } }));
    case 'instagram':
      return list('accounts').map((o) => ({ option: base(o, 'business'), body: { originId: o.id, name: o.name, avatar: o.avatar, pageId: o['pageId'] } }));
    case 'linkedin':
      return [...list('pages').map((o) => ['page', o] as const), ...list('profile').map((o) => ['profile', o] as const)].map(([kind, o]) => ({
        option: base(o, kind, `${kind}:${o.id}`), body: { type: kind, originId: o.id, name: o.name, avatar: o.avatar, urn: o['urn'] },
      }));
    case 'google':
      return list('locations').map((o) => {
        const location = (o['location'] ?? {}) as Record<string, unknown>;
        const address = location['storefrontAddress'] as { addressLines?: string[]; locality?: string } | undefined;
        return {
          option: { id: String(location['name'] ?? ''), name: String(location['title'] ?? location['name'] ?? 'Location'), avatar: null, kind: 'location',
            detail: [address?.addressLines?.join(', '), address?.locality].filter(Boolean).join(', ') || null, connected: !!location['isConnected'] },
          body: { location: o['location'], account: o['account'] },
        };
      });
    case 'tiktok':
      return list('profile').map((o) => ({ option: base(o, 'profile'), body: { type: o['type'] ?? 'profile', originId: o.id, name: o.name, avatar: o.avatar, verified: !!o['verified'], username: o['username'], connectionSource: 'social_media_posting' } }));
    case 'youtube':
      return list('profile').map((o) => ({ option: base(o, 'channel'), body: { type: 'profile', originId: o.id, name: o.name, avatar: o.avatar, verified: !!o['verified'], username: o['username'] } }));
    case 'pinterest':
      return list('profile').map((o) => ({ option: base(o, 'profile'), body: { type: 'profile', originId: o.id, name: o.name, avatar: o.avatar, verified: !!o['verified'], username: o['username'] ?? '', websiteUrl: o['websiteUrl'] ?? '', originAccountType: o['type'] } }));
    case 'threads':
      return list('profile').map((o) => ({ option: base(o, 'profile'), body: { type: 'profile', originId: o.id, name: o.name, avatar: o.avatar } }));
  }
}

async function loadChoices(conn: BrandGhl, platform: ConnectPlatform, oauthAccountId: string) {
  const r = await ghlFetch<{ results?: Record<string, unknown> }>(
    `/social-media-posting/oauth/${encodeURIComponent(conn.locationId)}/${platform}/accounts/${encodeURIComponent(oauthAccountId)}`, { token: conn.token });
  return choicesFor(platform, r.results ?? {}).filter((c) => c.option.id);
}

/** Step 2: after the popup, the pages/profiles the user may connect. */
export async function connectionOptions(ctx: AuthContext, clientId: string, input: unknown) {
  const data = validate(z.object({ platform: connectPlatformSchema, account_id: ghlIdSchema }))(input);
  const account = await brandAccess(ctx, clientId, true);
  const choices = await loadChoices(await brandGhl(ctx.db, account.id), data.platform, data.account_id);
  return choices.map((c) => c.option);
}

/** Step 3: connect the chosen page/profile, then make it available for posting. */
export async function attachConnection(ctx: AuthContext, clientId: string, input: unknown) {
  const data = validate(z.object({ platform: connectPlatformSchema, account_id: ghlIdSchema, option_id: z.string().min(1).max(400) }))(input);
  const account = await brandAccess(ctx, clientId, true);
  const conn = await brandGhl(ctx.db, account.id);
  const choice = (await loadChoices(conn, data.platform, data.account_id)).find((c) => c.option.id === data.option_id);
  if (!choice) throw new Error('That page or profile is no longer available. Connect again.');
  await ghlFetch(`/social-media-posting/oauth/${encodeURIComponent(conn.locationId)}/${data.platform}/accounts/${encodeURIComponent(data.account_id)}`,
    { token: conn.token, json: choice.body });
  await syncBrandAccounts(ctx.db, account.id, conn);
  return brandConnections(ctx, clientId);
}

export async function removeConnection(ctx: AuthContext, clientId: string, input: unknown) {
  const data = validate(z.object({ id: ghlIdSchema }))(input);
  const account = await brandAccess(ctx, clientId, true);
  const conn = await brandGhl(ctx.db, account.id);
  if (!(await ghlAccounts(conn)).some((a) => a.id === data.id)) throw new Error('That account is not connected to this brand.');
  await ghlFetch(`/social-media-posting/${encodeURIComponent(conn.locationId)}/accounts/${encodeURIComponent(data.id)}`, { token: conn.token, method: 'DELETE' });
  await syncBrandAccounts(ctx.db, account.id, conn);
  return brandConnections(ctx, clientId);
}

// ---------- Keeping n8n publishing in step ----------
/** Brand fields n8n accepts back (server-only and computed fields removed). */
function writableBrand(brand: Record<string, unknown>) {
  const { created_at: _c, updated_at: _u, has_ghl_token: _h, ...rest } = brand;
  return rest;
}

/**
 * Saves the brand's connected accounts in n8n (new ones ticked for posting, existing ticks kept) and,
 * for agency-connected brands, a fresh GHL token, so the existing n8n publishing keeps working.
 */
export async function syncBrandAccounts(db: Collections, accountId: string, conn: BrandGhl) {
  const account = await db.subAccounts.findOne({ id: accountId });
  if (!account) return;
  const [brand, live] = await Promise.all([n8nBrand(account.client_id), ghlAccounts(conn)]);
  const before = new Map((brand.ghl_accounts ?? []).map((a) => [a.id, a]));
  const ghl_accounts: GhlAccount[] = live.map((a) => ({
    id: a.id, platform: a.platform ?? 'unknown', name: a.name ?? '', isExpired: !!a.isExpired, enabled: before.get(a.id)?.enabled ?? true,
  }));
  const userId = conn.userId ?? (await actingUser(conn).catch(() => null));
  await sm('sm/brands', { method: 'POST', body: {
    ...writableBrand(brand as Record<string, unknown>), ghl_accounts, ghl_location_id: conn.locationId,
    ...(conn.source === 'agency' ? { ghl_token: conn.token, ...(brand.ghl_user_id || !userId ? {} : { ghl_user_id: userId }) } : {}),
  } });
  if (conn.source === 'agency') await db.ghlLocationTokens.updateOne({ location_id: conn.locationId }, { $set: { pushed_to_brand_at: new Date() } });
}

/**
 * Before publishing, make sure n8n holds a valid GHL token for agency-connected brands
 * (sub-account tokens last about a day). Brands with their own token are untouched.
 */
export async function ensurePublishingToken(db: Collections, accountId: string) {
  const account = await db.subAccounts.findOne({ id: accountId });
  if (!account || !ghlApp() || !(await db.ghlConnections.findOne({ agency_id: account.agency_id }))) return;
  const conn = await brandGhl(db, accountId);
  const cached = await db.ghlLocationTokens.findOne({ location_id: conn.locationId });
  const pushed = cached?.pushed_to_brand_at;
  // Pushed after the current token was minted and that token still has hours left: nothing to do.
  if (!conn.minted && pushed && cached && pushed >= cached.updated_at && cached.expires_at.getTime() - Date.now() > 2 * 3600_000) return;
  const brand = await n8nBrand(account.client_id);
  await sm('sm/brands', { method: 'POST', body: { ...writableBrand(brand as Record<string, unknown>), ghl_token: conn.token, ghl_location_id: conn.locationId } });
  await db.ghlLocationTokens.updateOne({ location_id: conn.locationId }, { $set: { pushed_to_brand_at: new Date() } });
}
