import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '@/http';

const { sm, accountForClient } = vi.hoisted(() => ({ sm: vi.fn(), accountForClient: vi.fn() }));
vi.mock('@/lib/mavera/sm-api.server', () => ({ smRequest: sm }));
vi.mock('@/lib/mavera/tenant.server', () => ({ accountForClient }));
const { connectAccounts, connectAttach, connectStart, retrySetup, setAccountsEnabled } = await import('@/services/connections');

const ctx = { db: {}, userId: 'me', user: {} } as unknown as AuthContext;
beforeEach(() => {
  sm.mockReset();
  accountForClient.mockReset().mockResolvedValue({ id: 'sub-1', client_id: 'acme-cafe' });
});

describe('connect start', () => {
  it('checks the user may manage the brand, then returns the login address from n8n', async () => {
    sm.mockResolvedValue({ ok: true, url: 'https://www.facebook.com/dialog/oauth?x=1', platform: 'facebook' });
    await expect(connectStart(ctx, 'acme-cafe', { platform: 'facebook' })).resolves.toEqual({ url: 'https://www.facebook.com/dialog/oauth?x=1', platform: 'facebook' });
    expect(accountForClient).toHaveBeenCalledWith(ctx.db, 'me', 'acme-cafe', true);
    expect(sm).toHaveBeenCalledWith('sm/ghl/connect/start?client_id=acme-cafe&platform=facebook');
  });
  it('never calls n8n for a brand the user cannot manage', async () => {
    accountForClient.mockRejectedValue(new Error('Administrator access required'));
    await expect(connectStart(ctx, 'other-brand', { platform: 'facebook' })).rejects.toThrow(/Administrator/);
    expect(sm).not.toHaveBeenCalled();
  });
  it('passes n8n errors through unchanged and rejects unknown platforms', async () => {
    sm.mockRejectedValue(new Error('Brand has no GHL sub-account yet'));
    await expect(connectStart(ctx, 'acme-cafe', { platform: 'facebook' })).rejects.toThrow('Brand has no GHL sub-account yet');
    await expect(connectStart(ctx, 'acme-cafe', { platform: 'myspace' })).rejects.toThrow(/supported platform/);
  });
});

describe('pages and attaching', () => {
  it('lists pages for the popup login', async () => {
    sm.mockResolvedValue({ ok: true, accounts: [{ origin_id: '42', name: 'Acme Page', raw: { a: 1 } }] });
    await expect(connectAccounts(ctx, 'acme-cafe', { platform: 'facebook', account_id: 'abc123' })).resolves.toHaveLength(1);
    expect(sm).toHaveBeenCalledWith('sm/ghl/connect/accounts?client_id=acme-cafe&platform=facebook&account_id=abc123');
  });
  it('sends the picked pages unchanged (including raw) for this brand only', async () => {
    sm.mockResolvedValue({ ok: true, results: [{ name: 'Acme Page', ok: true }], accounts: [{ id: 'g1', platform: 'facebook', name: 'Acme Page', enabled: true }] });
    const page = { origin_id: '42', name: 'Acme Page', raw: { token: 'kept as is' } };
    const r = await connectAttach(ctx, 'acme-cafe', { platform: 'facebook', account_id: 'abc123', accounts: [page], client_id: 'someone-else' });
    expect(sm).toHaveBeenCalledWith('sm/ghl/connect/attach', { method: 'POST', body: { client_id: 'acme-cafe', platform: 'facebook', account_id: 'abc123', accounts: [page] } });
    expect(r.accounts[0]).toMatchObject({ name: 'Acme Page', enabled: true });
  });
});

describe('turning accounts on and off', () => {
  it('only changes this brand\'s own accounts and saves the whole list', async () => {
    sm.mockImplementation(async (path: string) => (path.startsWith('sm/brands?')
      ? { brands: [{ client_id: 'acme-cafe', name: 'Acme Cafe', ghl_accounts: [{ id: 'g1', platform: 'facebook', enabled: true }, { id: 'g2', platform: 'tiktok', enabled: true }] }] }
      : { ok: true }));
    const accounts = await setAccountsEnabled(ctx, 'acme-cafe', { accounts: [{ id: 'g2', enabled: false }, { id: 'not-ours', enabled: true }] });
    expect(accounts).toEqual([{ id: 'g1', platform: 'facebook', enabled: true }, { id: 'g2', platform: 'tiktok', enabled: false }]);
    expect(sm).toHaveBeenLastCalledWith('sm/brands', { method: 'POST', body: { client_id: 'acme-cafe', name: 'Acme Cafe', ghl_accounts: accounts } });
  });
  it('retries a failed setup by saving the brand again', async () => {
    sm.mockImplementation(async (path: string) => (path.startsWith('sm/brands?') ? { brands: [{ client_id: 'acme-cafe', name: 'Acme Cafe' }] } : { ok: true }));
    await retrySetup(ctx, 'acme-cafe');
    expect(sm).toHaveBeenLastCalledWith('sm/brands', { method: 'POST', body: { client_id: 'acme-cafe', name: 'Acme Cafe' } });
  });
});
