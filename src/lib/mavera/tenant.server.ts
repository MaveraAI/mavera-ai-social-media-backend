// Tenant access rules, ported from the Postgres RLS policies and SECURITY DEFINER
// functions (agency_admin, sub_account_access, reserve_sub_account_videos,
// change_sub_account_member, accept_sub_account_invitation). MongoDB has no row
// level security, so every server function must go through these checks.
import type { ClientSession } from 'mongodb';
import type { Collections, InvitationDoc, SubAccountDoc } from '@/lib/db/mongo.server';
import { monthKey, type SubAccount } from './tenant-shared';

type Session = ClientSession | undefined;
const noId = { projection: { _id: 0 } } as const;
const inSession = (session: Session) => (session ? { session } : {});

export function toSubAccount(doc: SubAccountDoc): SubAccount & { created_at: string } {
  return {
    id: doc.id,
    agency_id: doc.agency_id,
    client_id: doc.client_id,
    name: doc.name,
    timezone: doc.timezone,
    monthly_video_limit: doc.monthly_video_limit,
    created_at: new Date(doc.created_at).toISOString(),
  };
}
export const iso = (value: Date | null | undefined) => (value ? new Date(value).toISOString() : null);

export async function isAgencyAdmin(c: Collections, userId: string, agencyId: string, session?: Session) {
  return !!(await c.agencyMemberships.findOne({ agency_id: agencyId, user_id: userId, role: 'admin' }, inSession(session)));
}

/** sub_account_access(): agency administrators, or an active (not revoked) member; `admin` requires the admin role. */
export async function subAccountAccess(c: Collections, userId: string, account: Pick<SubAccountDoc, 'id' | 'agency_id'>, admin = false, session?: Session) {
  if (await isAgencyAdmin(c, userId, account.agency_id, session)) return true;
  const member = await c.subAccountMemberships.findOne(
    { sub_account_id: account.id, user_id: userId, revoked_at: null, ...(admin ? { role: 'admin' as const } : {}) },
    inSession(session),
  );
  return !!member;
}

/** Every sub-account the user may see (the old sub_accounts_read policy), ordered by name. */
export async function visibleAccounts(c: Collections, userId: string) {
  const [agencies, memberships] = await Promise.all([
    c.agencyMemberships.find({ user_id: userId, role: 'admin' }).toArray(),
    c.subAccountMemberships.find({ user_id: userId, revoked_at: null }).toArray(),
  ]);
  const docs = await c.subAccounts
    .find({ $or: [{ agency_id: { $in: agencies.map((a) => a.agency_id) } }, { id: { $in: memberships.map((m) => m.sub_account_id) } }] }, noId)
    .sort({ name: 1 })
    .toArray();
  return docs.map(toSubAccount);
}

async function checkedAccount(c: Collections, userId: string, doc: SubAccountDoc | null, admin: boolean) {
  if (!doc || !(await subAccountAccess(c, userId, doc))) throw new Error('Sub-account unavailable or access denied');
  if (admin && !(await subAccountAccess(c, userId, doc, true))) throw new Error('Administrator access required');
  return toSubAccount(doc);
}
export async function accountForClient(c: Collections, userId: string, clientId: string, admin = false) {
  return checkedAccount(c, userId, await c.subAccounts.findOne({ client_id: clientId }, noId), admin);
}
export async function accountById(c: Collections, userId: string, id: string, admin = false) {
  return checkedAccount(c, userId, await c.subAccounts.findOne({ id }, noId), admin);
}
export async function requireAgency(c: Collections, userId: string, agencyId?: string) {
  const membership = await c.agencyMemberships.findOne({ user_id: userId, role: 'admin', ...(agencyId ? { agency_id: agencyId } : {}) });
  if (!membership) throw new Error('Agency administrator access required');
  return membership.agency_id;
}

/** Locks a sub-account for the rest of the transaction; concurrent writers conflict and retry. */
async function lockSubAccount(c: Collections, id: string, session: ClientSession) {
  return c.subAccounts.findOneAndUpdate({ id }, { $inc: { lock_version: 1 } }, { session, returnDocument: 'after', ...noId });
}

type Tx = <T>(fn: (session: ClientSession) => Promise<T>) => Promise<T>;

/** reserve_sub_account_videos(): returns the reservation id, or throws when the monthly allowance would be exceeded. */
export async function reserveVideos(c: Collections, tx: Tx, userId: string, subId: string, count: number) {
  if (!Number.isInteger(count) || count < 0 || count > 5) throw new Error('Request zero to five videos');
  return tx(async (session) => {
    const account = await lockSubAccount(c, subId, session);
    if (!account || !(await subAccountAccess(c, userId, account, false, session))) throw new Error('Access denied');
    const month = monthKey(new Date(), account.timezone);
    const rows = await c.reservations.find({ sub_account_id: subId, month_key: month }, { session, projection: { charged: 1 } }).toArray();
    const used = rows.reduce((n, r) => n + r.charged, 0);
    // Image-only requests (zero videos) stay allowed even when earlier usage exceeds the allowance.
    if (count > 0 && used + count > account.monthly_video_limit) throw new Error('Monthly video allowance exceeded');
    const id = crypto.randomUUID();
    await c.reservations.insertOne(
      { id, sub_account_id: subId, user_id: userId, month_key: month, requested: count, charged: count, job_id: null, state: 'reserved', created_at: new Date() },
      { session },
    );
    return id;
  });
}

/** change_sub_account_member(): remove / restore keep the membership row so access can be restored later. */
export async function changeMemberAccess(c: Collections, tx: Tx, userId: string, subId: string, target: string, action: 'admin' | 'member' | 'remove' | 'restore') {
  return tx(async (session) => {
    const account = await lockSubAccount(c, subId, session);
    if (!account || !(await subAccountAccess(c, userId, account, true, session))) throw new Error('Administrator access required');
    if (target === userId) throw new Error('You cannot change your own access here');
    if (await isAgencyAdmin(c, target, account.agency_id, session)) throw new Error('Agency administrators retain agency-wide access');
    const member = await c.subAccountMemberships.findOne({ sub_account_id: subId, user_id: target }, { session });
    if (!member) throw new Error('Previously granted membership required');
    const key = { sub_account_id: subId, user_id: target };
    if (action === 'remove') {
      await c.subAccountMemberships.updateOne(key, { $set: { revoked_at: member.revoked_at ?? new Date() } }, { session });
      const user = await c.users.findOne({ _id: target }, { session });
      if (user?.email) {
        await c.invitations.updateMany(
          { sub_account_id: subId, accepted_at: null, revoked_at: null, email: user.email.toLowerCase() },
          { $set: { revoked_at: new Date() } },
          { session },
        );
      }
    } else if (action === 'restore') {
      await c.subAccountMemberships.updateOne(key, { $set: { revoked_at: null } }, { session });
    } else if (member.revoked_at === null) {
      await c.subAccountMemberships.updateOne(key, { $set: { role: action } }, { session });
    } else {
      throw new Error('Invalid access change');
    }
  });
}

/** accept_sub_account_invitation(): verified recipient only; restores a revoked membership with the invited role. */
export async function acceptInvitationFor(c: Collections, tx: Tx, user: { id: string; email: string }, tokenHash: string) {
  const record = await c.users.findOne({ _id: user.id });
  if (!record?.emailVerified) throw new Error('Verify your email first');
  const pending = await c.invitations.findOne({ token_hash: tokenHash });
  if (!pending) throw new Error('Invitation expired or unavailable');
  return tx(async (session) => {
    await lockSubAccount(c, pending.sub_account_id, session);
    const invitation: InvitationDoc | null = await c.invitations.findOne({ token_hash: tokenHash }, { session });
    if (!invitation || invitation.revoked_at || invitation.accepted_at || new Date(invitation.expires_at).getTime() <= Date.now()) {
      throw new Error('Invitation expired or unavailable');
    }
    if (invitation.email.toLowerCase() !== record.email.toLowerCase()) throw new Error('Sign in with the invited email');
    const key = { sub_account_id: invitation.sub_account_id, user_id: user.id };
    const existing = await c.subAccountMemberships.findOne(key, { session });
    if (!existing) {
      await c.subAccountMemberships.insertOne({ ...key, role: invitation.role, revoked_at: null }, { session });
    } else if (existing.revoked_at) {
      await c.subAccountMemberships.updateOne(key, { $set: { revoked_at: null, role: invitation.role } }, { session });
    }
    await c.invitations.updateOne({ id: invitation.id }, { $set: { accepted_at: new Date() } }, { session });
    return invitation.sub_account_id;
  });
}
