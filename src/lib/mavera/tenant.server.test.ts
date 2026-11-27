import { describe, expect, it } from 'vitest';
import type { Collections } from '@/lib/db/mongo.server';
import { monthKey } from './tenant-shared';
import { AccountDeletionBlocked, accountForClient, hasPendingInvitation, imagesUsed, acceptInvitationFor, changeMemberAccess, leaveAllAccounts, requireAgency, reserveVideos, visibleAccounts } from './tenant.server';

// Minimal in-memory stand-in for the MongoDB collections used by tenant.server.
type Doc = Record<string, any>;
function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$or') return (expected as Doc[]).some(f => matches(doc, f));
    const actual = doc[key];
    if (expected && typeof expected === 'object' && !(expected instanceof Date) && '$in' in expected) return (expected.$in as unknown[]).includes(actual);
    if (expected && typeof expected === 'object' && !(expected instanceof Date) && '$ne' in expected) return actual !== expected.$ne;
    if (expected && typeof expected === 'object' && !(expected instanceof Date) && '$gt' in expected) return actual > expected.$gt;
    if (expected === null) return actual === null || actual === undefined;
    return actual === expected;
  });
}
function collection(rows: Doc[] = []) {
  const apply = (doc: Doc, update: Doc) => {
    Object.assign(doc, update['$set'] ?? {});
    for (const [k, v] of Object.entries(update['$inc'] ?? {})) doc[k] = (doc[k] ?? 0) + (v as number);
  };
  return {
    rows,
    findOne: async (f: Doc) => rows.find(r => matches(r, f)) ?? null,
    find: (f: Doc) => {
      let result = rows.filter(r => matches(r, f));
      const cursor = { sort: (s: Doc) => { const [k] = Object.keys(s); result = [...result].sort((a, b) => String(a[k!]).localeCompare(String(b[k!]))); return cursor; }, toArray: async () => result };
      return cursor;
    },
    findOneAndUpdate: async (f: Doc, u: Doc) => { const doc = rows.find(r => matches(r, f)); if (doc) apply(doc, u); return doc ?? null; },
    insertOne: async (d: Doc) => { rows.push(d); },
    updateOne: async (f: Doc, u: Doc) => { const doc = rows.find(r => matches(r, f)); if (doc) apply(doc, u); },
    updateMany: async (f: Doc, u: Doc) => { rows.filter(r => matches(r, f)).forEach(d => apply(d, u)); },
    countDocuments: async (f: Doc) => rows.filter(r => matches(r, f)).length,
    deleteMany: async (f: Doc) => { for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i]!, f)) rows.splice(i, 1); },
  };
}
const tx = <T,>(fn: (session: never) => Promise<T>) => fn(undefined as never);
const account = { id: 'assigned-account', client_id: 'assigned-brand', agency_id: 'agency', name: 'Assigned', timezone: 'Europe/London', monthly_video_limit: 3, created_at: new Date('2026-01-01') };
const hidden = { ...account, id: 'hidden-account', client_id: 'other-brand', agency_id: 'other-agency', name: 'Hidden' };
function db(seed: Partial<Record<keyof Collections, Doc[]>> = {}) {
  return {
    agencies: collection(seed.agencies), agencyMemberships: collection(seed.agencyMemberships),
    subAccounts: collection(seed.subAccounts ?? [{ ...account }, { ...hidden }]),
    subAccountMemberships: collection(seed.subAccountMemberships), invitations: collection(seed.invitations),
    jobs: collection(seed.jobs), reservations: collection(seed.reservations), users: collection(seed.users),
  } as unknown as Collections & Record<keyof Collections, { rows: Doc[] }>;
}
const member = (role: 'admin' | 'member', revoked_at: Date | null = null) => ({ sub_account_id: account.id, user_id: 'me', role, revoked_at });
const expected = { id: account.id, agency_id: 'agency', client_id: 'assigned-brand', name: 'Assigned', timezone: 'Europe/London', monthly_video_limit: 3, monthly_image_limit: 30, created_at: account.created_at.toISOString() };

describe('server-side sub-account permissions', () => {
  it('an assigned member can read their brand', async () => {
    await expect(accountForClient(db({ subAccountMemberships: [member('member')] }), 'me', 'assigned-brand')).resolves.toEqual(expected);
  });
  it('an unassigned user cannot read a hidden brand', async () => {
    await expect(accountForClient(db({ subAccountMemberships: [member('member')] }), 'me', 'other-brand')).rejects.toThrow('access denied');
  });
  it('a revoked member loses access', async () => {
    await expect(accountForClient(db({ subAccountMemberships: [member('member', new Date())] }), 'me', 'assigned-brand')).rejects.toThrow('access denied');
  });
  it('a member cannot change administrator-only brand settings', async () => {
    await expect(accountForClient(db({ subAccountMemberships: [member('member')] }), 'me', 'assigned-brand', true)).rejects.toThrow('Administrator access required');
  });
  it('an assigned administrator can change their brand settings', async () => {
    await expect(accountForClient(db({ subAccountMemberships: [member('admin')] }), 'me', 'assigned-brand', true)).resolves.toEqual(expected);
  });
  it('an agency administrator sees every brand of their agency only', async () => {
    const accounts = await visibleAccounts(db({ agencyMemberships: [{ agency_id: 'agency', user_id: 'me', role: 'admin' }] }), 'me');
    expect(accounts.map(a => a.id)).toEqual([account.id]);
  });
  it('a sub-account membership alone does not grant agency administrator access', async () => {
    await expect(requireAgency(db({ subAccountMemberships: [member('admin')] }), 'me')).rejects.toThrow('Agency administrator access required');
  });
});

describe('monthly video reservations', () => {
  const thisMonth = monthKey(new Date(), 'Europe/London');
  const used = (charged: number) => [{ id: 'r1', sub_account_id: account.id, user_id: 'me', month_key: thisMonth, requested: charged, charged, job_id: null, state: 'done', created_at: new Date() }];
  it('reserves videos within the allowance', async () => {
    const d = db({ subAccountMemberships: [member('member')], reservations: used(1) });
    await expect(reserveVideos(d, tx, 'me', account.id, 2)).resolves.toEqual(expect.any(String));
    expect(d.reservations.rows).toHaveLength(2);
  });
  it('rejects videos beyond the allowance', async () => {
    await expect(reserveVideos(db({ subAccountMemberships: [member('member')], reservations: used(2) }), tx, 'me', account.id, 2)).rejects.toThrow('Monthly video allowance exceeded');
  });
  it('allows image-only generation even when usage already exceeds the allowance', async () => {
    await expect(reserveVideos(db({ subAccountMemberships: [member('member')], reservations: used(9) }), tx, 'me', account.id, 0)).resolves.toEqual(expect.any(String));
  });
  it('denies users without access', async () => {
    await expect(reserveVideos(db(), tx, 'me', account.id, 0)).rejects.toThrow('Access denied');
  });
  it('counts images against the monthly image allowance (30 by default)', async () => {
    const month = monthKey(new Date(), 'Europe/London');
    const images = (n: number, state = 'done') => [{ id: `i${n}`, sub_account_id: account.id, user_id: 'me', month_key: month, requested: 0, charged: 0, images: n, job_id: `job-i${n}`, state }];
    const d = db({ subAccountMemberships: [member('member')], reservations: images(26) });
    await expect(reserveVideos(d, tx, 'me', account.id, 0, 4)).resolves.toEqual(expect.any(String));
    expect(d.reservations.rows.at(-1)).toMatchObject({ images: 4 });
    await expect(reserveVideos(d, tx, 'me', account.id, 0, 1)).rejects.toThrow('Monthly image allowance reached: 30 of 30 images used this month, so 0 more can be created.');
    // Released campaigns give their images back.
    const freed = db({ subAccountMemberships: [member('member')], reservations: images(30, 'released') });
    await expect(reserveVideos(freed, tx, 'me', account.id, 0, 30)).resolves.toEqual(expect.any(String));
  });
  it('only counts the images a finished campaign actually created', () => {
    expect(imagesUsed([{ images: 5, images_charged: 2, state: 'done' }, { images: 3, state: 'accepted' }, { images: 4, state: 'released' }, { images: 1, images_charged: 0, state: 'done' }])).toBe(5);
  });
});

describe('membership changes and invitations', () => {
  const invitation = (email: string) => ({ id: 'i1', sub_account_id: account.id, email, role: 'admin', token_hash: 'hash', invited_by: 'boss', expires_at: new Date(Date.now() + 60_000), accepted_at: null, revoked_at: null, created_at: new Date() });
  const verified = { _id: 'me', email: 'me@example.com', emailVerified: true };
  it('accepting an invitation restores a revoked membership with the invited role', async () => {
    const d = db({ users: [verified], invitations: [invitation('me@example.com')], subAccountMemberships: [member('member', new Date())] });
    await expect(acceptInvitationFor(d, tx, { id: 'me', email: 'me@example.com' }, 'hash')).resolves.toBe(account.id);
    expect(d.subAccountMemberships.rows[0]).toMatchObject({ role: 'admin', revoked_at: null });
    expect(d.invitations.rows[0]!['accepted_at']).toBeInstanceOf(Date);
  });
  it('an invitation for another email cannot be accepted', async () => {
    const d = db({ users: [verified], invitations: [invitation('someone@example.com')] });
    await expect(acceptInvitationFor(d, tx, { id: 'me', email: 'me@example.com' }, 'hash')).rejects.toThrow('Sign in with the invited email');
  });
  it('an unverified user cannot accept an invitation', async () => {
    const d = db({ users: [{ ...verified, emailVerified: false }], invitations: [invitation('me@example.com')] });
    await expect(acceptInvitationFor(d, tx, { id: 'me', email: 'me@example.com' }, 'hash')).rejects.toThrow('Verify your email first');
  });
  it('removing a member keeps the row and revokes their pending invitations', async () => {
    const d = db({
      users: [{ _id: 'them', email: 'them@example.com', emailVerified: true }],
      subAccountMemberships: [member('admin'), { sub_account_id: account.id, user_id: 'them', role: 'member', revoked_at: null }],
      invitations: [invitation('them@example.com')],
    });
    await changeMemberAccess(d, tx, 'me', account.id, 'them', 'remove');
    expect(d.subAccountMemberships.rows[1]!['revoked_at']).toBeInstanceOf(Date);
    expect(d.invitations.rows[0]!['revoked_at']).toBeInstanceOf(Date);
    await changeMemberAccess(d, tx, 'me', account.id, 'them', 'restore');
    expect(d.subAccountMemberships.rows[1]!['revoked_at']).toBeNull();
  });
  it('agency administrators cannot be removed from a sub-account', async () => {
    const d = db({
      agencyMemberships: [{ agency_id: 'agency', user_id: 'them', role: 'admin' }],
      subAccountMemberships: [member('admin'), { sub_account_id: account.id, user_id: 'them', role: 'member', revoked_at: null }],
    });
    await expect(changeMemberAccess(d, tx, 'me', account.id, 'them', 'remove')).rejects.toThrow('Agency administrators retain agency-wide access');
  });
});

describe('deleting your own account', () => {
  const me = { id: 'me', email: 'me@example.com' };
  const other = (role: 'admin' | 'member', revoked_at: Date | null = null) => ({ sub_account_id: account.id, user_id: 'them', role, revoked_at });
  const mavera = [{ agency_id: 'agency', user_id: 'mavera', role: 'admin' }];
  it('is refused while you are the only admin and others still use the brand, even if the agency has admins', async () => {
    const d = db({ subAccountMemberships: [member('admin'), other('member')], agencyMemberships: mavera });
    await expect(leaveAllAccounts(d, tx, me)).rejects.toThrow(AccountDeletionBlocked);
    await expect(leaveAllAccounts(d, tx, me)).rejects.toThrow("You're the only administrator of Assigned. Make someone else an administrator");
    expect(d.subAccountMemberships.rows[0]!['revoked_at']).toBeNull();
  });
  it('a revoked admin does not count as another admin', async () => {
    await expect(leaveAllAccounts(db({ subAccountMemberships: [member('admin'), other('admin', new Date())] }), tx, me)).resolves.toBeUndefined();
    const d = db({ subAccountMemberships: [member('admin'), other('admin', new Date()), { ...other('member'), user_id: 'third' }] });
    await expect(leaveAllAccounts(d, tx, me)).rejects.toThrow(AccountDeletionBlocked);
  });
  it('is allowed when another admin stays, and marks your access as a deleted account', async () => {
    const d = db({
      subAccountMemberships: [member('admin'), other('admin')],
      invitations: [{ id: 'i1', invited_by: 'me', accepted_at: null, revoked_at: null }, { id: 'i2', invited_by: 'them', accepted_at: null, revoked_at: null }],
    });
    await leaveAllAccounts(d, tx, me);
    expect(d.subAccountMemberships.rows[0]).toMatchObject({ revoked_at: expect.any(Date), account_deleted_at: expect.any(Date), former_email: 'me@example.com' });
    expect(d.subAccountMemberships.rows[1]!['revoked_at']).toBeNull();
    expect(d.subAccountMemberships.rows[1]!['account_deleted_at']).toBeUndefined();
    expect(d.invitations.rows.map((i) => !!i['revoked_at'])).toEqual([true, false]);
  });
  it('is allowed when nobody else uses the brand, and for plain members', async () => {
    await expect(leaveAllAccounts(db({ subAccountMemberships: [member('admin')] }), tx, me)).resolves.toBeUndefined();
    const d = db({ subAccountMemberships: [member('member'), other('member')] });
    await leaveAllAccounts(d, tx, me);
    expect(d.subAccountMemberships.rows[0]!['revoked_at']).toBeInstanceOf(Date);
  });
  it('the only agency administrator cannot leave, another one can', async () => {
    await expect(leaveAllAccounts(db({ agencyMemberships: [{ agency_id: 'agency', user_id: 'me', role: 'admin' }] }), tx, me)).rejects.toThrow('only agency administrator');
    const d = db({ agencyMemberships: [{ agency_id: 'agency', user_id: 'me', role: 'admin' }, { agency_id: 'agency', user_id: 'boss', role: 'admin' }] });
    await leaveAllAccounts(d, tx, me);
    expect(d.agencyMemberships.rows.map((r) => r['user_id'])).toEqual(['boss']);
  });
  it('a deleted account cannot be given access again', async () => {
    const d = db({ subAccountMemberships: [member('admin'), { ...other('member', new Date()), account_deleted_at: new Date() }], users: [] });
    await expect(changeMemberAccess(d, tx, 'me', account.id, 'them', 'restore')).rejects.toThrow('deleted their account');
  });
});

describe('invitation-only sign-up', () => {
  const inv = (email: string, extra: Doc = {}) => ({ id: email, email, accepted_at: null, revoked_at: null, expires_at: new Date(Date.now() + 60_000), ...extra });
  it('lets only an email with a live invitation create a login', async () => {
    const d = db({ invitations: [inv('new@team.com'), inv('used@team.com', { accepted_at: new Date() }), inv('pulled@team.com', { revoked_at: new Date() }), inv('late@team.com', { expires_at: new Date(Date.now() - 1000) })] });
    await expect(hasPendingInvitation(d, ' New@Team.com ')).resolves.toBe(true);
    for (const email of ['stranger@x.com', 'used@team.com', 'pulled@team.com', 'late@team.com']) await expect(hasPendingInvitation(d, email)).resolves.toBe(false);
  });
});
