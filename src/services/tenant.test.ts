import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '@/http';

vi.mock('@/lib/mavera/tenant.server', async (orig) => ({ ...(await orig<object>()), visibleAccounts: vi.fn(async () => []) }));
const { completeTour, listAccounts } = await import('./tenant');

function ctx(user: Record<string, unknown> | null) {
  const updates: unknown[] = [];
  const db = {
    agencyMemberships: { countDocuments: async () => 0 },
    subAccountMemberships: { find: () => ({ toArray: async () => [] }) },
    users: { findOne: async () => user, updateOne: async (...a: unknown[]) => { updates.push(a); } },
  };
  return { c: { db, userId: 'me', user: {} } as unknown as AuthContext, updates };
}

describe('welcome tour progress', () => {
  it('tells the app whether the user has seen the tour', async () => {
    await expect(listAccounts(ctx({ _id: 'me' }).c)).resolves.toMatchObject({ tourCompleted: false });
    await expect(listAccounts(ctx({ _id: 'me', tour_completed_at: new Date() }).c)).resolves.toMatchObject({ tourCompleted: true });
  });
  it('saves that the user finished or skipped it', async () => {
    const { c, updates } = ctx({ _id: 'me' });
    await expect(completeTour(c)).resolves.toEqual({ ok: true });
    expect(updates[0]).toEqual([{ _id: 'me' }, { $set: { tour_completed_at: expect.any(Date) } }]);
  });
});
