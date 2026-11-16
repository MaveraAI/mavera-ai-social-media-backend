import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptToken, encryptToken, hashState } from '@/lib/ghl/tokens.server';
import { ghlStartUrl } from '@/lib/ghl/ghl.server';
import { choicesFor, completeAgencyInstall } from '@/services/connections';
import type { Collections } from '@/lib/db/mongo.server';

beforeEach(() => {
  vi.stubEnv('BETTER_AUTH_SECRET', 'test-secret-that-is-long-enough-for-hkdf');
  vi.stubEnv('FRONTEND_URL', 'https://social.example.com');
  vi.stubEnv('GHL_CLIENT_ID', 'cid');
  vi.stubEnv('GHL_CLIENT_SECRET', 'csecret');
  vi.stubEnv('BETTER_AUTH_URL', 'https://api.example.com');
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('token storage', () => {
  it('encrypts so the stored value never contains the token, and decrypts it back', () => {
    const stored = encryptToken('pit-secret-123');
    expect(stored).not.toContain('pit-secret-123');
    expect(encryptToken('pit-secret-123')).not.toBe(stored); // fresh IV each time
    expect(decryptToken(stored)).toBe('pit-secret-123');
  });
  it('rejects tampered values', () => {
    const [v, iv, tag, data] = encryptToken('abc').split('.');
    const flipped = `${data![0] === 'A' ? 'B' : 'A'}${data!.slice(1)}`;
    expect(() => decryptToken([v, iv, tag, flipped].join('.'))).toThrow();
  });
});

describe('choices after the platform popup', () => {
  it('builds the attach body GHL expects for each platform', () => {
    const fb = choicesFor('facebook', { pages: [{ id: '42', name: 'Aura Glow', avatar: 'a.png', isConnected: false }] });
    expect(fb[0]).toEqual({ option: { id: '42', name: 'Aura Glow', avatar: 'a.png', kind: 'page', connected: false }, body: { type: 'page', originId: '42', name: 'Aura Glow', avatar: 'a.png' } });
    const ig = choicesFor('instagram', { accounts: [{ id: '7', name: 'auraglow', pageId: '42' }] });
    expect(ig[0]?.body).toMatchObject({ originId: '7', pageId: '42' });
    const li = choicesFor('linkedin', { pages: [{ id: '1', name: 'Co', urn: 'urn:li:organization:1' }], profile: [{ id: '1', name: 'Me', urn: 'urn:li:person:1' }] });
    expect(li.map((c) => c.option.id)).toEqual(['page:1', 'profile:1']); // same numeric id, still unique
    expect(li[1]?.body).toMatchObject({ type: 'profile', urn: 'urn:li:person:1' });
    const g = choicesFor('google', { locations: [{ location: { name: 'locations/9', title: 'Shop', storefrontAddress: { addressLines: ['1 High St'], locality: 'London' } }, account: { name: 'accounts/1' } }] });
    expect(g[0]?.option).toMatchObject({ id: 'locations/9', name: 'Shop', detail: '1 High St, London' });
    expect(g[0]?.body).toEqual({ location: { name: 'locations/9', title: 'Shop', storefrontAddress: { addressLines: ['1 High St'], locality: 'London' } }, account: { name: 'accounts/1' } });
    expect(choicesFor('tiktok', { profile: [{ id: 'o1', name: 'T', username: 'tt' }] })[0]?.body).toMatchObject({ type: 'profile', originId: 'o1', connectionSource: 'social_media_posting' });
    expect(choicesFor('youtube', {})).toEqual([]);
  });
});

describe('platform login address', () => {
  it('follows GHL\'s redirect once and returns the platform login page', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://www.facebook.com/v18.0/dialog/oauth?state=x' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(ghlStartUrl('tok', 'facebook', 'loc1', 'user1')).resolves.toBe('https://www.facebook.com/v18.0/dialog/oauth?state=x');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://services.leadconnectorhq.com/social-media-posting/oauth/facebook/start?locationId=loc1&userId=user1');
    expect(init.redirect).toBe('manual');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer tok');
  });
  it('explains an expired connection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"message":"Invalid JWT"}', { status: 401 })));
    await expect(ghlStartUrl('tok', 'facebook', 'loc1', 'user1')).rejects.toThrow(/Reconnect GHL/);
  });
});

describe('agency install callback', () => {
  function db(state: { agency_id: string; user_id: string } | null) {
    const updates: unknown[] = [];
    return {
      updates,
      c: {
        ghlStates: { findOneAndDelete: vi.fn(async (q: { state_hash: string }) => (state && q.state_hash === hashState('good') ? state : null)) },
        ghlConnections: { updateOne: vi.fn(async (...a: unknown[]) => { updates.push(a); }) },
        ghlLocationTokens: { deleteMany: vi.fn(async () => ({})) },
      } as unknown as Collections,
    };
  }
  it('rejects unknown or reused state', async () => {
    await expect(completeAgencyInstall(db(null).c, 'code', 'bad')).resolves.toMatch(/ghl=error&reason=This%20link%20expired/);
  });
  it('stores encrypted agency tokens and returns to the agency page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ access_token: 'AT', refresh_token: 'RT', expires_in: 86399, companyId: 'co1', userId: 'u1', userType: 'Company' })));
    const d = db({ agency_id: 'ag1', user_id: 'me' });
    await expect(completeAgencyInstall(d.c, 'code', 'good')).resolves.toBe('https://social.example.com/agency?ghl=connected');
    const [filter, update] = d.updates[0] as [unknown, { $set: Record<string, unknown> }];
    expect(filter).toEqual({ agency_id: 'ag1' });
    expect(update.$set['company_id']).toBe('co1');
    expect(JSON.stringify(update)).not.toContain('"AT"');
    expect(decryptToken(update.$set['access_token_enc'] as string)).toBe('AT');
  });
  it('asks for an agency-wide install when GHL returns a single sub-account', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ access_token: 'AT', refresh_token: 'RT', locationId: 'l1', userType: 'Location' })));
    await expect(completeAgencyInstall(db({ agency_id: 'ag1', user_id: 'me' }).c, 'code', 'good')).resolves.toMatch(/whole%20agency/);
  });
});
