import { describe, expect, it, vi } from 'vitest';
import { SignJWT, base64url } from 'jose';
import type { Collections } from '@/lib/db/mongo.server';
import { claimJti, findWelcomeAccount, welcomeRedirect, type WelcomeAccount, type WelcomeDeps } from './welcome.server';

const SECRET = 'test-secret-that-is-at-least-32-chars!!';
const FRONTEND = 'https://social.mavera.ai';
const LOGIN = `${FRONTEND}/auth`;
const SETUP_LINK = 'https://api.example/api/auth/reset-password/abc?callbackURL=https%3A%2F%2Fsocial.mavera.ai%2Freset-password';
const now = Math.floor(Date.now() / 1000);
const claims = {
  email: 'Owner@Company.com', brand_name: 'Company Ltd', user_name: 'Jane Smith',
  mavera_tenant_id: '142b3380-bb9c-41bc-aea3-4053eba163dd', idempotency_key: 'mavera-tenant-142b3380-bb9c-41bc-aea3-4053eba163dd',
  plan: 'front_desk_team', jti: 'jti-1',
};

async function token(over: Record<string, unknown> = {}, opts: { secret?: string; alg?: string; iss?: string; aud?: string; exp?: number } = {}) {
  return new SignJWT({ ...claims, ...over })
    .setProtectedHeader({ alg: opts.alg ?? 'HS256', typ: 'JWT' })
    .setIssuer(opts.iss ?? 'mavera-ai').setAudience(opts.aud ?? 'mavera-socials')
    .setIssuedAt(now).setExpirationTime(opts.exp ?? now + 600)
    .sign(new TextEncoder().encode(opts.secret ?? SECRET));
}

function deps(account: WelcomeAccount | null = { email: 'owner@company.com', passwordSetupPending: true }) {
  const used = new Set<string>();
  return {
    secret: SECRET, frontendUrl: FRONTEND,
    claimJti: vi.fn(async (jti: string) => { if (used.has(jti)) return false; used.add(jti); return true; }),
    findAccount: vi.fn(async (_key: string | undefined, _email: string) => account),
    setupLink: vi.fn(async (_email: string) => SETUP_LINK as string | null),
  } satisfies WelcomeDeps;
}

describe('GET /mavera/welcome', () => {
  it('valid token, password not set: redirects to a fresh set-password link', async () => {
    const d = deps();
    await expect(welcomeRedirect(await token(), d)).resolves.toEqual({ location: SETUP_LINK, outcome: 'set_password', jti: 'jti-1' });
    expect(d.findAccount).toHaveBeenCalledWith(claims.idempotency_key, 'owner@company.com');
    expect(d.setupLink).toHaveBeenCalledWith('owner@company.com');
  });

  it('valid token, password set: redirects to log in with the email filled in', async () => {
    const d = deps({ email: 'owner+shop@company.com', passwordSetupPending: false });
    await expect(welcomeRedirect(await token(), d)).resolves.toMatchObject({ location: `${LOGIN}?email=owner%2Bshop%40company.com`, outcome: 'login' });
    expect(d.setupLink).not.toHaveBeenCalled();
  });

  it('expired token: redirects to log in, but allows up to 60 seconds of clock skew', async () => {
    await expect(welcomeRedirect(await token({}, { exp: now - 120 }), deps())).resolves.toEqual({ location: LOGIN, outcome: 'expired' });
    await expect(welcomeRedirect(await token({}, { exp: now - 30 }), deps())).resolves.toMatchObject({ outcome: 'set_password' });
  });

  it('wrong signature or a different alg: redirects to log in', async () => {
    const d = deps();
    await expect(welcomeRedirect(await token({}, { secret: 'a-different-secret-of-32-characters!!' }), d)).resolves.toEqual({ location: LOGIN, outcome: 'invalid_token' });
    await expect(welcomeRedirect(await token({}, { alg: 'HS512' }), d)).resolves.toEqual({ location: LOGIN, outcome: 'invalid_token' });
    const header = base64url.encode(JSON.stringify({ alg: 'none', typ: 'JWT' }));
    const body = base64url.encode(JSON.stringify({ ...claims, iss: 'mavera-ai', aud: 'mavera-socials', exp: now + 600 }));
    await expect(welcomeRedirect(`${header}.${body}.`, d)).resolves.toEqual({ location: LOGIN, outcome: 'invalid_token' });
    const [h, p] = (await token()).split('.');
    await expect(welcomeRedirect(`${h}.${p}.${'A'.repeat(43)}`, d)).resolves.toEqual({ location: LOGIN, outcome: 'invalid_token' });
    expect(d.claimJti).not.toHaveBeenCalled();
  });

  it('same token used twice: the second use redirects to log in', async () => {
    const d = deps();
    const t = await token();
    await expect(welcomeRedirect(t, d)).resolves.toMatchObject({ outcome: 'set_password' });
    await expect(welcomeRedirect(t, d)).resolves.toEqual({ location: LOGIN, outcome: 'reused', jti: 'jti-1' });
    expect(d.setupLink).toHaveBeenCalledTimes(1);
  });

  it('wrong iss or aud: redirects to log in', async () => {
    await expect(welcomeRedirect(await token({}, { iss: 'someone-else' }), deps())).resolves.toEqual({ location: LOGIN, outcome: 'invalid_token' });
    await expect(welcomeRedirect(await token({}, { aud: 'another-app' }), deps())).resolves.toEqual({ location: LOGIN, outcome: 'invalid_token' });
  });

  it('unknown account: redirects to log in', async () => {
    await expect(welcomeRedirect(await token(), deps(null))).resolves.toEqual({ location: LOGIN, outcome: 'account_not_found', jti: 'jti-1' });
  });

  it('missing token, missing jti, no secret configured or a failing database: redirects to log in', async () => {
    await expect(welcomeRedirect(undefined, deps())).resolves.toEqual({ location: LOGIN, outcome: 'missing_token' });
    await expect(welcomeRedirect(await token({ jti: undefined }), deps())).resolves.toMatchObject({ location: LOGIN, outcome: 'invalid_token' });
    await expect(welcomeRedirect(await token(), { ...deps(), secret: undefined })).resolves.toEqual({ location: LOGIN, outcome: 'not_configured' });
    const broken = { ...deps(), findAccount: vi.fn(async () => { throw new Error('db down'); }) };
    await expect(welcomeRedirect(await token(), broken)).resolves.toEqual({ location: LOGIN, outcome: 'error', jti: 'jti-1' });
  });

  it('falls back to log in (with the email) when no set-password link can be made', async () => {
    const d = { ...deps(), setupLink: vi.fn(async () => null) };
    await expect(welcomeRedirect(await token(), d)).resolves.toMatchObject({ location: `${LOGIN}?email=owner%40company.com`, outcome: 'link_failed' });
  });
});

type Row = { _id: string; email: string; password_setup_pending?: boolean };
describe('finding the account and one-use tokens', () => {
  const user: Row = { _id: 'u1', email: 'owner@company.com', password_setup_pending: true };
  function db(seed: { sub?: object; member?: object; stored?: object; users?: Row[] } = {}) {
    const users = seed.users ?? [user];
    return {
      subAccounts: { findOne: vi.fn(async () => seed.sub ?? null) },
      subAccountMemberships: { findOne: vi.fn(async () => seed.member ?? null) },
      idempotency: { findOne: vi.fn(async () => seed.stored ?? null) },
      users: {
        findOne: vi.fn(async (f: { _id?: string; email?: string }, o?: { collation?: unknown }) =>
          users.find((u) => (f._id ? u._id === f._id : o?.collation ? u.email.toLowerCase() === f.email?.toLowerCase() : u.email === f.email)) ?? null),
      },
      usedTokens: { insertOne: vi.fn() },
    } as unknown as Collections;
  }

  it('finds the account by the provisioning Idempotency-Key, then by the stored result, then by email in any case', async () => {
    await expect(findWelcomeAccount(db({ sub: { id: 's1' }, member: { user_id: 'u1' } }), 'mavera-tenant-x', 'someone@else.com')).resolves.toEqual({ email: 'owner@company.com', passwordSetupPending: true });
    await expect(findWelcomeAccount(db({ stored: { body: { data: { user_id: 'u1' } } } }), 'mavera-tenant-x', 'someone@else.com')).resolves.toMatchObject({ email: 'owner@company.com' });
    await expect(findWelcomeAccount(db({ users: [{ _id: 'u2', email: 'Owner@Company.com' }] }), undefined, 'owner@company.com')).resolves.toEqual({ email: 'Owner@Company.com', passwordSetupPending: false });
    await expect(findWelcomeAccount(db({ users: [] }), 'mavera-tenant-x', 'owner@company.com')).resolves.toBeNull();
  });

  it('accepts a jti once and refuses it after', async () => {
    const d = db();
    vi.mocked(d.usedTokens.insertOne).mockResolvedValueOnce({} as never).mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: 11000 }));
    await expect(claimJti(d, 'j', new Date())).resolves.toBe(true);
    await expect(claimJti(d, 'j', new Date())).resolves.toBe(false);
  });
});
