// Accounts, usage, members and invitations. Same rules as before the frontend/backend split;
// every function authorizes through lib/mavera/tenant.server before reading or writing.
import { z } from 'zod';
import type { AuthContext } from '@/http';
import { withTransaction } from '@/lib/db/mongo.server';
import { sendMail, linkEmail } from '@/lib/mail.server';
import { invitationState } from '@/lib/mavera/invitation-state';
import { validate } from '@/lib/mavera/sm-shared';
import { monthKey, remaining, type MonthlyUsage } from '@/lib/mavera/tenant-shared';
import { imagesUsed } from '@/lib/mavera/tenant.server';
import { accountById, acceptInvitationFor, changeMemberAccess, iso, requireAgency, subAccountAccess, visibleAccounts } from '@/lib/mavera/tenant.server';
import { isAllowedOrigin } from '@/config';

const id = z.string().uuid();
async function sha256(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function listAccounts({ db, userId }: AuthContext) {
  try {
    const [accounts, agencyMemberships, roles] = await Promise.all([
      visibleAccounts(db, userId),
      db.agencyMemberships.countDocuments({ user_id: userId }),
      db.subAccountMemberships.find({ user_id: userId, revoked_at: null }, { projection: { _id: 0, sub_account_id: 1, role: 1 } }).toArray(),
    ]);
    return { accounts, agencyAdmin: agencyMemberships > 0, roles: roles.map((r) => ({ sub_account_id: r.sub_account_id, role: r.role })) };
  } catch (error) {
    console.error('listAccounts failed', error);
    throw new Error('Could not load sub-accounts');
  }
}

export async function accountUsage(ctx: AuthContext, input: unknown) {
  const data = validate(z.object({ account_id: id }))(input);
  const account = await accountById(ctx.db, ctx.userId, data.account_id);
  const month = monthKey(new Date(), account.timezone);
  const rows = await ctx.db.reservations.find({ sub_account_id: account.id, month_key: month }, { projection: { _id: 0, charged: 1, images: 1, state: 1 } }).toArray()
    .catch(() => { throw new Error('Could not load usage'); });
  const used = rows.reduce((n, r) => n + r.charged, 0);
  const images = imagesUsed(rows);
  return {
    month, limit: account.monthly_video_limit, used, remaining: remaining(account.monthly_video_limit, used),
    images: { limit: account.monthly_image_limit, used: images, remaining: remaining(account.monthly_image_limit, images) },
  } satisfies MonthlyUsage;
}

export async function setVideoLimit(ctx: AuthContext, input: unknown) {
  const data = validate(z.object({ account_id: id, limit: z.number().int().min(0).max(100000), image_limit: z.number().int().min(0).max(100000).optional() }))(input);
  const account = await accountById(ctx.db, ctx.userId, data.account_id);
  await requireAgency(ctx.db, ctx.userId, account.agency_id);
  await ctx.db.subAccounts.updateOne({ id: account.id }, { $set: { monthly_video_limit: data.limit, ...(data.image_limit !== undefined ? { monthly_image_limit: data.image_limit } : {}) } })
    .catch(() => { throw new Error('Could not save video allowance'); });
  return { ok: true };
}

export async function accountPeople(ctx: AuthContext, input: unknown) {
  const data = validate(z.object({ account_id: id }))(input);
  const { db, userId } = ctx;
  const account = await accountById(db, userId, data.account_id, true);
  const [rows, agencyMembers, invitations] = await Promise.all([
    db.subAccountMemberships.find({ sub_account_id: account.id }).toArray(),
    db.agencyMemberships.find({ agency_id: account.agency_id, role: 'admin' }).toArray(),
    db.invitations.find({ sub_account_id: account.id }).sort({ created_at: -1 }).toArray(),
  ]).catch(() => { throw new Error('Could not load members'); });
  const users = await db.users.find({ _id: { $in: rows.map((r) => r.user_id) } }, { projection: { email: 1 } }).toArray();
  const emails = new Map(users.map((u) => [u._id, u.email]));
  const members = rows.map((r) => ({
    user_id: r.user_id, role: r.role, revoked_at: iso(r.revoked_at), email: emails.get(r.user_id) ?? 'Unavailable',
    protected: r.user_id === userId || agencyMembers.some((m) => m.user_id === r.user_id),
  }));
  return {
    members,
    invitations: invitations.map((i) => ({ id: i.id, email: i.email, role: i.role, expires_at: iso(i.expires_at)!, accepted_at: iso(i.accepted_at), revoked_at: iso(i.revoked_at) })),
  };
}

export async function changeMember(ctx: AuthContext, input: unknown) {
  const data = validate(z.object({ account_id: id, user_id: id, role: z.enum(['admin', 'member', 'remove', 'restore']) }))(input);
  await accountById(ctx.db, ctx.userId, data.account_id, true);
  if (data.user_id === ctx.userId) throw new Error('You cannot change your own access here');
  try {
    await changeMemberAccess(ctx.db, withTransaction, ctx.userId, data.account_id, data.user_id, data.role);
  } catch (error) {
    console.error('changeMember failed', error);
    throw new Error('Could not change access');
  }
  return { ok: true };
}

export async function inviteMember(ctx: AuthContext, input: unknown) {
  const data = validate(z.object({ account_id: id, email: z.string().email().max(254), role: z.enum(['admin', 'member']), origin: z.string().url() }))(input);
  // The invitation link must point at one of our own frontends.
  if (!isAllowedOrigin(new URL(data.origin).origin)) throw new Error('Invalid invitation origin');
  const account = await accountById(ctx.db, ctx.userId, data.account_id, true);
  const token = crypto.randomUUID() + crypto.randomUUID();
  const now = new Date();
  await ctx.db.invitations.insertOne({
    id: crypto.randomUUID(), sub_account_id: account.id, email: data.email.toLowerCase(), role: data.role, token_hash: await sha256(token),
    invited_by: ctx.userId, expires_at: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000), accepted_at: null, revoked_at: null, created_at: now,
  }).catch(() => { throw new Error('Could not create invitation'); });
  const url = `${new URL(data.origin).origin}/invite?token=${encodeURIComponent(token)}`;
  const emailed = await sendMail({
    to: data.email, subject: `You're invited to ${account.name} on Mavera AI`,
    ...linkEmail(`You've been invited to join ${account.name} on Mavera AI. Sign in or create an account with this email address to accept.`, url, 'Accept invitation'),
  });
  return { url, emailed };
}

export async function revokeInvitation(ctx: AuthContext, input: unknown) {
  const data = validate(z.object({ account_id: id, invitation_id: id }))(input);
  await accountById(ctx.db, ctx.userId, data.account_id, true);
  await ctx.db.invitations.updateOne({ id: data.invitation_id, sub_account_id: data.account_id, accepted_at: null }, { $set: { revoked_at: new Date() } })
    .catch(() => { throw new Error('Could not revoke invitation'); });
  return { ok: true };
}

export async function acceptInvitation(ctx: AuthContext, input: unknown) {
  const data = validate(z.object({ token: z.string().min(32).max(200) }))(input);
  try {
    const accountId = await acceptInvitationFor(ctx.db, withTransaction, ctx.user, await sha256(data.token));
    return { ok: true, accountId };
  } catch (error) {
    console.error('acceptInvitation failed', error instanceof Error ? error.message : error);
    throw new Error('Invitation unavailable, expired, or for a different verified email');
  }
}

export async function inspectInvitation(ctx: AuthContext, input: unknown) {
  const data = validate(z.object({ token: z.string().min(32).max(200) }))(input);
  const { db, userId } = ctx;
  const user = await db.users.findOne({ _id: userId });
  if (!user?.emailVerified || !user.email) throw new Error('Confirm your email before checking this invitation.');
  // A token alone never exposes another recipient's invitation or brand details.
  const invitation = await db.invitations.findOne({ token_hash: await sha256(data.token), email: user.email.toLowerCase() })
    .catch(() => { throw new Error('Could not check your invitation. Please retry.'); });
  if (!invitation) return { state: 'invalid' as const, name: null, accountId: null, role: null, expiresAt: null, canOpen: false };
  const state = invitationState({ accepted_at: iso(invitation.accepted_at), revoked_at: iso(invitation.revoked_at), expires_at: iso(invitation.expires_at)! });
  const brand = await db.subAccounts.findOne({ id: invitation.sub_account_id });
  const canOpen = !!brand && await subAccountAccess(db, userId, brand);
  return { state, name: brand?.name ?? 'this brand', accountId: invitation.sub_account_id, role: invitation.role, expiresAt: iso(invitation.expires_at), canOpen };
}
