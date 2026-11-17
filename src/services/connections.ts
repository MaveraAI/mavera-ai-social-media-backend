// Connecting social accounts. n8n does all the GHL work (sub-account, platform login, attaching pages);
// these functions check the user may manage the brand, then forward the call with the server-side secret.
// Users never see GHL, tokens, location IDs or user IDs.
import { z } from 'zod';
import type { AuthContext } from '@/http';
import { smRequest as sm } from '@/lib/mavera/sm-api.server';
import {
  attachSchema, clientIdSchema, connectPlatformSchema, ghlIdSchema, validate,
  type AttachResult, type Brand, type ConnectPage, type GhlAccount,
} from '@/lib/mavera/sm-shared';
import { accountForClient } from '@/lib/mavera/tenant.server';

const q = encodeURIComponent;

/** Connecting and changing accounts is for the brand's admins (and agency admins). */
async function brandAdmin(ctx: AuthContext, clientId: string) {
  const id = validate(clientIdSchema)(clientId);
  await accountForClient(ctx.db, ctx.userId, id, true);
  return id;
}

async function n8nBrand(clientId: string) {
  const { brands } = await sm<{ brands: Brand[] }>(`sm/brands?client_id=${q(clientId)}`);
  const brand = brands.find((b) => b.client_id === clientId);
  if (!brand) throw new Error('Brand profile not found');
  return brand;
}

/** Step 1: the platform login address for the popup. */
export async function connectStart(ctx: AuthContext, clientId: string, input: unknown) {
  const { platform } = validate(z.object({ platform: connectPlatformSchema }))(input);
  const id = await brandAdmin(ctx, clientId);
  const r = await sm<{ ok: boolean; url?: string }>(`sm/ghl/connect/start?client_id=${q(id)}&platform=${platform}`);
  if (typeof r.url !== 'string' || !/^https:\/\//i.test(r.url)) throw new Error('The connect service did not return a login address. Please retry.');
  return { url: r.url, platform };
}

/** Step 3: the pages or profiles that login can manage. */
export async function connectAccounts(ctx: AuthContext, clientId: string, input: unknown) {
  const { platform, account_id } = validate(z.object({ platform: connectPlatformSchema, account_id: ghlIdSchema }))(input);
  const id = await brandAdmin(ctx, clientId);
  const r = await sm<{ ok: boolean; accounts?: ConnectPage[] }>(`sm/ghl/connect/accounts?client_id=${q(id)}&platform=${platform}&account_id=${q(account_id)}`);
  return r.accounts ?? [];
}

/** Step 4: connect the picked pages (sent back unchanged, including `raw`). */
export async function connectAttach(ctx: AuthContext, clientId: string, input: unknown) {
  const data = validate(attachSchema)(input);
  const id = await brandAdmin(ctx, clientId);
  const r = await sm<{ ok: boolean } & Partial<AttachResult>>('sm/ghl/connect/attach', { method: 'POST', body: { client_id: id, ...data } });
  return { results: r.results ?? [], accounts: r.accounts ?? [] } satisfies AttachResult;
}

/** Turn accounts on or off for posting (the n8n API has no disconnect yet; off = not posted to). */
export async function setAccountsEnabled(ctx: AuthContext, clientId: string, input: unknown) {
  const { accounts } = validate(z.object({ accounts: z.array(z.object({ id: z.string().max(300), enabled: z.boolean() })).min(1).max(50) }))(input);
  const id = await brandAdmin(ctx, clientId);
  const brand = await n8nBrand(id);
  const wanted = new Map(accounts.map((a) => [a.id, a.enabled]));
  // Only the brand's own accounts can be changed; unknown IDs are ignored.
  const ghl_accounts: GhlAccount[] = (brand.ghl_accounts ?? []).map((a) => (wanted.has(a.id) ? { ...a, enabled: wanted.get(a.id)! } : a));
  await sm('sm/brands', { method: 'POST', body: { client_id: id, name: brand.name, ghl_accounts } });
  return ghl_accounts;
}

/** "Retry" after a failed setup: saving the brand again re-runs only the missing parts. */
export async function retrySetup(ctx: AuthContext, clientId: string) {
  const id = await brandAdmin(ctx, clientId);
  const brand = await n8nBrand(id);
  await sm('sm/brands', { method: 'POST', body: { client_id: id, name: brand.name } });
  return { ok: true };
}
