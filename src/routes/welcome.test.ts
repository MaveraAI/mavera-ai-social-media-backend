import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';

const SECRET = 'route-test-secret-that-is-32-chars-long';
const user = { _id: 'u1', email: 'owner@company.com', password_setup_pending: true };
const used = new Set<string>();
vi.mock('@/lib/auth.server', () => ({ createPasswordSetupLink: vi.fn(async () => 'https://api.example/api/auth/reset-password/tok?callbackURL=x') }));
vi.mock('@/lib/db/mongo.server', () => ({
  collections: async () => ({
    usedTokens: { insertOne: async (d: { _id: string }) => { if (used.has(d._id)) throw Object.assign(new Error('dup'), { code: 11000 }); used.add(d._id); } },
    subAccounts: { findOne: async () => null },
    subAccountMemberships: { findOne: async () => null },
    idempotency: { findOne: async () => null },
    users: { findOne: async (f: { email?: string }) => (f.email === user.email ? user : null) },
  }),
}));
vi.stubEnv('FRONTEND_URL', 'https://social.mavera.ai');
vi.stubEnv('MAVERA_REDIRECT_SECRET', SECRET);
const { welcome } = await import('./welcome');

const sign = (jti: string, email = 'owner@company.com') => new SignJWT({ email, jti })
  .setProtectedHeader({ alg: 'HS256' }).setIssuer('mavera-ai').setAudience('mavera-socials')
  .setIssuedAt().setExpirationTime('10m').sign(new TextEncoder().encode(SECRET));
const get = (query: string) => welcome.request(`/welcome${query}`);

afterEach(() => vi.restoreAllMocks());

describe('GET /mavera/welcome (HTTP)', () => {
  it('answers a valid first visit with a 302 to the set-password link, without caching', async () => {
    const res = await get(`?token=${await sign('route-1')}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://api.example/api/auth/reset-password/tok?callbackURL=x');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('always redirects to the log in page on a bad request, and ignores redirect/next parameters', async () => {
    for (const q of ['', '?token=not-a-jwt', '?token=a.b.c&redirect=https://evil.example', '?next=https://evil.example']) {
      const res = await get(q);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('https://social.mavera.ai/auth');
    }
  });

  it('never logs the token or the secret', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const token = await sign('route-2');
    await get(`?token=${token}`);
    await get(`?token=${token}`);
    const logged = JSON.stringify([...info.mock.calls, ...warn.mock.calls]);
    expect(logged).toContain('route-2');
    expect(logged).toContain('reused');
    expect(logged).not.toContain(token);
    expect(logged).not.toContain(SECRET);
  });
});
