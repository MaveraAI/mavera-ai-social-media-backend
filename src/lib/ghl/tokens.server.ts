// GHL tokens: encrypted at rest, refreshed before they expire, never sent to the browser.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import type { Collections, SubAccountDoc } from '@/lib/db/mongo.server';
import { smRequest as sm } from '@/lib/mavera/sm-api.server';
import type { Brand } from '@/lib/mavera/sm-shared';
import { GhlError, ghlApp, ghlFetch, ghlLocationToken, ghlToken } from './ghl.server';

// ---------- Encryption (AES-256-GCM) ----------
function key() {
  const explicit = process.env['GHL_TOKEN_KEY'];
  if (explicit) {
    const k = Buffer.from(explicit, 'base64');
    if (k.length !== 32) throw new Error('GHL_TOKEN_KEY must be 32 bytes, base64-encoded');
    return k;
  }
  // Without a dedicated key, derive one from the auth secret (rotating that secret means reconnecting GHL).
  const secret = process.env['BETTER_AUTH_SECRET'];
  if (!secret) throw new Error('Set GHL_TOKEN_KEY or BETTER_AUTH_SECRET to store GHL tokens');
  return Buffer.from(hkdfSync('sha256', secret, 'mavera-ghl', 'ghl-token-encryption', 32));
}
export function encryptToken(plain: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}
export function decryptToken(stored: string) {
  const [v, iv, tag, data] = stored.split('.');
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('Unreadable stored token');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}
export const hashState = (state: string) => createHash('sha256').update(state).digest('hex');

// ---------- Agency (Company) token ----------
const inflight = new Map<string, Promise<string>>();
/** Runs one refresh per key at a time: GHL refresh tokens are single-use. */
function once(k: string, fn: () => Promise<string>) {
  const running = inflight.get(k);
  if (running) return running;
  const p = fn().finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
}
const soon = (date: Date, minutes: number) => date.getTime() - Date.now() < minutes * 60_000;

export async function companyToken(db: Collections, agencyId: string) {
  const conn = await db.ghlConnections.findOne({ agency_id: agencyId });
  if (!conn) throw new Error('GHL is not connected for this agency.');
  if (!soon(conn.expires_at, 5)) return { token: decryptToken(conn.access_token_enc), companyId: conn.company_id, userId: conn.user_id };
  const token = await once(`company:${agencyId}`, async () => {
    const fresh = await db.ghlConnections.findOne({ agency_id: agencyId });
    if (fresh && !soon(fresh.expires_at, 5)) return decryptToken(fresh.access_token_enc);
    const r = await ghlToken({ refresh_token: decryptToken((fresh ?? conn).refresh_token_enc) }).catch((e: unknown) => {
      if (e instanceof GhlError && e.status < 500) throw new Error('The agency GHL connection has expired. An agency admin needs to reconnect GHL.');
      throw e;
    });
    await db.ghlConnections.updateOne({ agency_id: agencyId }, { $set: {
      access_token_enc: encryptToken(r.access_token), refresh_token_enc: encryptToken(r.refresh_token ?? decryptToken((fresh ?? conn).refresh_token_enc)),
      expires_at: new Date(Date.now() + (r.expires_in ?? 86_000) * 1000), updated_at: new Date(),
    } });
    return r.access_token;
  });
  return { token, companyId: conn.company_id, userId: conn.user_id };
}

/** A sub-account token minted from the agency token (cached until 30 minutes before it expires). */
export async function locationToken(db: Collections, agencyId: string, locationId: string) {
  const cached = await db.ghlLocationTokens.findOne({ location_id: locationId, agency_id: agencyId });
  if (cached && !soon(cached.expires_at, 30)) return { token: decryptToken(cached.access_token_enc), userId: cached.user_id, minted: false };
  let userId: string | null = null;
  const token = await once(`location:${locationId}`, async () => {
    const company = await companyToken(db, agencyId);
    const r = await ghlLocationToken(company.token, company.companyId, locationId).catch((e: unknown) => {
      if (e instanceof GhlError && (e.status === 400 || e.status === 404 || e.status === 422)) throw new Error('This GHL sub-account is not part of the connected agency, or the Mavera app is not installed on it.');
      throw e;
    });
    userId = r.userId ?? company.userId ?? null;
    await db.ghlLocationTokens.updateOne({ location_id: locationId }, {
      $set: { agency_id: agencyId, user_id: userId, access_token_enc: encryptToken(r.access_token), expires_at: new Date(Date.now() + (r.expires_in ?? 86_000) * 1000), updated_at: new Date() },
      $setOnInsert: { pushed_to_brand_at: null },
    }, { upsert: true });
    return r.access_token;
  });
  return { token, userId: userId ?? cached?.user_id ?? null, minted: true };
}

export const agencyConnected = async (db: Collections, agencyId: string) => !!(await db.ghlConnections.findOne({ agency_id: agencyId }, { projection: { _id: 1 } }));

// ---------- Per brand ----------
/** The brand profile as n8n stores it. */
export async function n8nBrand(clientId: string) {
  const { brands } = await sm<{ brands: Brand[] }>(`sm/brands?client_id=${encodeURIComponent(clientId)}`);
  const brand = brands.find((b) => b.client_id === clientId);
  if (!brand) throw new Error('Brand profile not found');
  return brand;
}

/** The brand's GHL location, cached on the sub-account so connection screens don't wait for n8n. */
export async function locationFor(db: Collections, account: Pick<SubAccountDoc, 'id' | 'client_id'> & { ghl_location_id?: string | null }) {
  if (account.ghl_location_id) return account.ghl_location_id;
  const brand = await n8nBrand(account.client_id);
  if (!brand.ghl_location_id) return null;
  await db.subAccounts.updateOne({ id: account.id }, { $set: { ghl_location_id: brand.ghl_location_id, ...(brand.ghl_user_id ? { ghl_user_id: brand.ghl_user_id } : {}) } });
  return brand.ghl_location_id;
}

export type BrandGhl = { token: string; locationId: string; source: 'agency' | 'token'; userId: string | null; minted: boolean };

/** How this brand reaches GHL right now, or a plain reason why it can't. */
export async function brandGhl(db: Collections, accountId: string): Promise<BrandGhl> {
  const account = await db.subAccounts.findOne({ id: accountId });
  if (!account) throw new Error('Sub-account not found');
  const locationId = await locationFor(db, account);
  const viaAgency = !!ghlApp() && await agencyConnected(db, account.agency_id);
  if (!locationId) throw new Error(viaAgency ? 'Choose this brand\'s GHL sub-account in Your brand, then save.' : 'Add the GHL Location ID in Your brand, then save.');
  if (viaAgency) {
    const t = await locationToken(db, account.agency_id, locationId);
    return { token: t.token, locationId, source: 'agency', userId: account.ghl_user_id || t.userId, minted: t.minted };
  }
  if (account.ghl_private_token_enc) {
    return { token: decryptToken(account.ghl_private_token_enc), locationId, source: 'token', userId: account.ghl_user_id ?? null, minted: false };
  }
  throw new Error('Connect GHL once in Agency settings (or paste the private integration token in Your brand and save) to connect social accounts here.');
}

/** A GHL user to act as (GHL requires one when connecting accounts). */
export async function actingUser(conn: BrandGhl) {
  if (conn.userId) return conn.userId;
  const r = await ghlFetch<{ users?: { id: string; roles?: { role?: string } }[] }>(`/users/?locationId=${encodeURIComponent(conn.locationId)}`, { token: conn.token })
    .catch(() => ({ users: [] }));
  const users = r.users ?? [];
  const user = users.find((u) => u.roles?.role === 'admin') ?? users[0];
  if (!user) throw new Error('Add the GHL User ID in Your brand, then save.');
  return user.id;
}
