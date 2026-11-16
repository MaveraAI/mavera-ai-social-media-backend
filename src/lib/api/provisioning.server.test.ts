import { describe, expect, it, vi } from 'vitest';
import type { Collections } from '@/lib/db/mongo.server';
import { defaultPlan } from '@/lib/mavera/plans.server';
import {
  ApiError, hitRateLimit, isAuthorized, parseProvisionInput, provisionSubAccount, requestHash, withIdempotency, type ProvisionDeps,
} from './provisioning.server';

// In-memory stand-in for the MongoDB collections the provisioning code touches.
type Doc = Record<string, any>;
const matches = (doc: Doc, filter: Doc) => Object.entries(filter).every(([k, v]) => doc[k] === v);
function collection(unique: string[] = []) {
  const rows: Doc[] = [];
  const dup = () => Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
  return {
    rows,
    findOne: async (f: Doc) => rows.find((r) => matches(r, f)) ?? null,
    find: (f: Doc) => { const c = { limit: () => c, toArray: async () => rows.filter((r) => matches(r, f)) }; return c; },
    insertOne: async (d: Doc) => { if (unique.some((k) => rows.some((r) => r[k] === d[k]))) throw dup(); rows.push({ ...d }); },
    updateOne: async (f: Doc, u: Doc) => { const d = rows.find((r) => matches(r, f)); if (d) Object.assign(d, u['$set']); },
    deleteOne: async (f: Doc) => { const i = rows.findIndex((r) => matches(r, f)); if (i >= 0) rows.splice(i, 1); },
    deleteMany: async (f: Doc) => { for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i]!, f)) rows.splice(i, 1); },
    findOneAndUpdate: async (f: Doc, u: Doc) => {
      const d: Doc = rows.find((r) => matches(r, f)) ?? (() => { const created: Doc = { ...f, ...u['$setOnInsert'] }; rows.push(created); return created; })();
      for (const [k, v] of Object.entries(u['$inc'] ?? {})) d[k] = (d[k] ?? 0) + (v as number);
      return d;
    },
  };
}
function db() {
  const c = {
    agencies: collection(['id']), agencyMemberships: collection(), subAccounts: collection(['id', 'client_id']),
    subAccountMemberships: collection(), invitations: collection(), jobs: collection(), reservations: collection(),
    users: collection(['_id', 'email']), authAccounts: collection(['_id']), idempotency: collection(['key']), rateLimits: collection(['_id']),
  };
  c.agencies.rows.push({ id: 'agency-1', name: 'Mavera Agency' });
  return c as unknown as Collections & Record<keyof Collections, { rows: Doc[] }>;
}
const tx = <T,>(fn: (s: never) => Promise<T>) => fn(undefined as never);
function deps(d: ReturnType<typeof db>, sm: ProvisionDeps['sm'] = vi.fn(async (path: string) => (path.startsWith('sm/brands?') ? { brands: [] } : { ok: true })) as ProvisionDeps['sm']): ProvisionDeps {
  return { db: d, tx, sm, hashPassword: async (p) => `hashed:${p.length}`, plan: { name: 'default', monthly_video_limit: 10 }, agencyId: undefined, sendPasswordSetup: async () => true };
}
const input = parseProvisionInput({ user_name: 'John Doe', email: 'John@Example.com', brand_name: "John's Clothing Brand" });

describe('API secret', () => {
  const env = { PROVISIONING_API_SECRET: 's'.repeat(40), PROVISIONING_API_SECRET_PREVIOUS: 'p'.repeat(40) };
  it('accepts the current and previous secret as a Bearer token', () => {
    expect(isAuthorized(`Bearer ${'s'.repeat(40)}`, env)).toBe(true);
    expect(isAuthorized(`Bearer ${'p'.repeat(40)}`, env)).toBe(true);
  });
  it('rejects missing, wrong or malformed tokens, and everything when no secret is configured', () => {
    expect(isAuthorized(null, env)).toBe(false);
    expect(isAuthorized('Bearer wrong', env)).toBe(false);
    expect(isAuthorized('s'.repeat(40), env)).toBe(false);
    expect(isAuthorized('Bearer anything', {})).toBe(false);
  });
});

describe('request validation', () => {
  it('normalises the email and keeps the names', () => {
    expect(input).toEqual({ user_name: 'John Doe', email: 'john@example.com', brand_name: "John's Clothing Brand" });
  });
  it('lists every problem', () => {
    try { parseProvisionInput({ email: 'nope', timezone: 'Mars/Base' }); throw new Error('should fail'); }
    catch (e) { expect(e).toBeInstanceOf(ApiError); expect((e as ApiError).status).toBe(400); expect((e as ApiError).errors?.length).toBeGreaterThanOrEqual(3); }
  });
});

describe('default plan', () => {
  it('reads the configured allowance and falls back to 0', () => {
    expect(defaultPlan({ DEFAULT_MONTHLY_VIDEO_LIMIT: '10' })).toEqual({ name: 'default', monthly_video_limit: 10 });
    expect(defaultPlan({})).toEqual({ name: 'default', monthly_video_limit: 0 });
    expect(defaultPlan({ DEFAULT_MONTHLY_VIDEO_LIMIT: 'lots' }).monthly_video_limit).toBe(0);
  });
});

describe('sub-account provisioning', () => {
  it('creates the user, login, sub-account with the default plan, membership and brand profile', async () => {
    const d = db();
    const sm = vi.fn(async (path: string) => (path.startsWith('sm/brands?') ? { brands: [] } : { ok: true })) as unknown as ProvisionDeps['sm'];
    const result = await provisionSubAccount(deps(d, sm), input);
    expect(result.status).toBe(201);
    const data = result.body['data'] as Record<string, unknown>;
    expect(data).toMatchObject({ client_id: 'john-s-clothing-brand', brand_name: "John's Clothing Brand", plan: 'default', monthly_video_limit: 10, password_setup_email_sent: true });
    expect(d.users.rows[0]).toMatchObject({ _id: data['user_id'], email: 'john@example.com', name: 'John Doe', emailVerified: true });
    expect(d.authAccounts.rows[0]).toMatchObject({ userId: data['user_id'], providerId: 'credential' });
    expect(d.subAccounts.rows[0]).toMatchObject({ id: data['account_id'], agency_id: 'agency-1', monthly_video_limit: 10, timezone: 'Europe/London' });
    expect(d.subAccountMemberships.rows[0]).toMatchObject({ user_id: data['user_id'], role: 'admin', revoked_at: null });
    expect(sm).toHaveBeenLastCalledWith('sm/brands', { method: 'POST', body: expect.objectContaining({ client_id: 'john-s-clothing-brand', name: "John's Clothing Brand", platforms: ['instagram', 'facebook'] }) });
  });
  it('refuses a second account for the same email', async () => {
    const d = db();
    await provisionSubAccount(deps(d), input);
    await expect(provisionSubAccount(deps(d), { ...input, brand_name: 'Another Brand' })).rejects.toMatchObject({ status: 409, message: 'An account already exists for this email' });
  });
  it('refuses a brand ID that exists here or in the content service', async () => {
    const d = db();
    await provisionSubAccount(deps(d), input);
    await expect(provisionSubAccount(deps(d), { ...input, email: 'other@example.com' })).rejects.toMatchObject({ status: 409 });
    const upstreamTaken = vi.fn(async () => ({ brands: [{ client_id: 'taken-brand', name: 'Taken' }] })) as unknown as ProvisionDeps['sm'];
    await expect(provisionSubAccount(deps(db(), upstreamTaken), { ...input, brand_name: 'Taken Brand' })).rejects.toMatchObject({ status: 409 });
  });
  it('leaves nothing behind when the brand profile cannot be created', async () => {
    const d = db();
    const failing = vi.fn(async (path: string) => { if (path === 'sm/brands') throw new Error('down'); return { brands: [] }; }) as unknown as ProvisionDeps['sm'];
    await expect(provisionSubAccount(deps(d, failing), input)).rejects.toMatchObject({ status: 502 });
    expect([d.users.rows, d.authAccounts.rows, d.subAccounts.rows, d.subAccountMemberships.rows].every((r) => r.length === 0)).toBe(true);
  });
});

describe('idempotency', () => {
  it('replays a success for the same key and body, and rejects a different body', async () => {
    const d = db();
    const run = vi.fn(async () => ({ status: 201, body: { success: true } }));
    await withIdempotency(d, 'key-1', 'hash-a', run);
    await expect(withIdempotency(d, 'key-1', 'hash-a', run)).resolves.toMatchObject({ status: 201, replayed: true });
    expect(run).toHaveBeenCalledTimes(1);
    await expect(withIdempotency(d, 'key-1', 'hash-b', run)).rejects.toMatchObject({ status: 422 });
  });
  it('frees the key when the request fails, so it can be retried', async () => {
    const d = db();
    await expect(withIdempotency(d, 'key-2', 'h', async () => { throw new ApiError(502, 'down'); })).rejects.toMatchObject({ status: 502 });
    await expect(withIdempotency(d, 'key-2', 'h', async () => ({ status: 201, body: {} }))).resolves.toMatchObject({ status: 201 });
  });
  it('hashes the same request the same way', () => {
    expect(requestHash(input)).toBe(requestHash({ ...input }));
    expect(requestHash(input)).not.toBe(requestHash({ ...input, brand_name: 'Other' }));
  });
});

describe('rate limiting', () => {
  it('allows the limit per minute, then asks the caller to wait', async () => {
    const d = db();
    const now = Date.parse('2026-11-14T10:00:30Z');
    for (let i = 0; i < 3; i++) expect((await hitRateLimit(d, 'ip', 3, now)).allowed).toBe(true);
    const blocked = await hitRateLimit(d, 'ip', 3, now);
    expect(blocked).toEqual({ allowed: false, retryAfterSeconds: 30 });
    expect((await hitRateLimit(d, 'ip', 3, now + 60_000)).allowed).toBe(true);
  });
});
