// Server-only MongoDB access. Import from other *.server.ts modules, or load
// inside server handlers with `await import('@/lib/db/mongo.server')`.
import { MongoClient, type ClientSession, type Collection, type Db } from 'mongodb';

export type AgencyDoc = { id: string; name: string; created_at: Date };
export type AgencyMembershipDoc = { agency_id: string; user_id: string; role: 'admin' };
export type SubAccountDoc = {
  id: string;
  agency_id: string;
  client_id: string;
  name: string;
  timezone: string;
  monthly_video_limit: number;
  /** Missing on older accounts: the default plan's image allowance applies. */
  monthly_image_limit?: number;
  created_at: Date;
  /** Bumped inside transactions so concurrent writers on one sub-account conflict and retry, like SELECT ... FOR UPDATE. */
  lock_version?: number;
  /** Idempotency-Key of the provisioning request that created it (e.g. mavera-tenant-<id>), used by /mavera/welcome. */
  idempotency_key?: string | null;
};
export type SubAccountMembershipDoc = {
  sub_account_id: string; user_id: string; role: 'admin' | 'member'; revoked_at: Date | null;
  /** Set when the person deleted their own login; the email is kept so the team can still see who it was. */
  account_deleted_at?: Date | null; former_email?: string | null;
};
export type InvitationDoc = {
  id: string;
  sub_account_id: string;
  email: string;
  role: 'admin' | 'member';
  token_hash: string;
  invited_by: string;
  expires_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
};
export type SubAccountJobDoc = { job_id: string; sub_account_id: string; created_at: Date };
export type ReservationState = 'reserved' | 'accepted' | 'done' | 'released' | 'uncertain';
export type VideoReservationDoc = {
  id: string;
  sub_account_id: string;
  user_id: string;
  month_key: string;
  requested: number;
  charged: number;
  /** Images this campaign asked for (counted against the monthly image allowance unless released). */
  images?: number;
  /** Set when the campaign finishes: images actually created. Failed images are given back. */
  images_charged?: number;
  job_id: string | null;
  state: ReservationState;
  /** "revise" when the video was used by editing or regenerating a post (post_id says which). */
  kind?: 'campaign' | 'revise';
  post_id?: string | null;
  created_at: Date;
};
/** Better Auth's `user` collection; `_id` is the user's UUID string. */
export type AuthUserDoc = {
  _id: string; name: string; email: string; emailVerified: boolean; image?: string | null; createdAt: Date; updatedAt: Date;
  /** When the user finished or skipped the welcome tour (so it starts by itself only once, on any device). */
  tour_completed_at?: Date | null;
  /** True from provisioning until the user chooses their own password (cleared on password reset). */
  password_setup_pending?: boolean;
};
/** Better Auth's `account` collection; email/password logins use providerId "credential". */
export type AuthAccountDoc = { _id: string; accountId: string; providerId: string; userId: string; password?: string | null; createdAt: Date; updatedAt: Date };
/** Stored results of provisioning requests, replayed for a repeated Idempotency-Key (expires after 24 hours). */
export type IdempotencyDoc = { key: string; request_hash: string; state: 'pending' | 'done'; status?: number; body?: unknown; created_at: Date };
/** One-use redirect tokens (by jti) already accepted; each row expires with its token. */
export type UsedTokenDoc = { _id: string; expires_at: Date };
/** Fixed-window request counters for the public API (expire automatically). */
export type RateLimitDoc = { _id: string; count: number; expires_at: Date };

export type Collections = {
  agencies: Collection<AgencyDoc>;
  agencyMemberships: Collection<AgencyMembershipDoc>;
  subAccounts: Collection<SubAccountDoc>;
  subAccountMemberships: Collection<SubAccountMembershipDoc>;
  invitations: Collection<InvitationDoc>;
  jobs: Collection<SubAccountJobDoc>;
  reservations: Collection<VideoReservationDoc>;
  users: Collection<AuthUserDoc>;
  authAccounts: Collection<AuthAccountDoc>;
  idempotency: Collection<IdempotencyDoc>;
  rateLimits: Collection<RateLimitDoc>;
  usedTokens: Collection<UsedTokenDoc>;
};

type MongoState = { client: MongoClient; db: Db; indexes?: Promise<void> | undefined; connecting?: Promise<void> | undefined };
const globalMongo = globalThis as typeof globalThis & { __maveraMongo?: MongoState };

/** One client per server process; reused across dev hot reloads. The driver connects lazily on first use. */
export function getMongo(): MongoState {
  if (globalMongo.__maveraMongo) return globalMongo.__maveraMongo;
  const uri = process.env['MONGODB_URI'];
  if (!uri) {
    const message = 'Missing MONGODB_URI environment variable. Add it to .env.local (local) or your hosting settings.';
    console.error(`[MongoDB] ${message}`);
    throw new Error('Database is not configured');
  }
  const client = new MongoClient(uri, { appName: 'mavera-brand-studio' });
  const db = client.db(process.env['MONGODB_DB'] || 'mavera');
  globalMongo.__maveraMongo = { client, db };
  return globalMongo.__maveraMongo;
}

function collectionsFor(db: Db): Collections {
  return {
    agencies: db.collection<AgencyDoc>('agencies'),
    agencyMemberships: db.collection<AgencyMembershipDoc>('agency_memberships'),
    subAccounts: db.collection<SubAccountDoc>('sub_accounts'),
    subAccountMemberships: db.collection<SubAccountMembershipDoc>('sub_account_memberships'),
    invitations: db.collection<InvitationDoc>('sub_account_invitations'),
    jobs: db.collection<SubAccountJobDoc>('sub_account_jobs'),
    reservations: db.collection<VideoReservationDoc>('video_reservations'),
    users: db.collection<AuthUserDoc>('user'),
    authAccounts: db.collection<AuthAccountDoc>('account'),
    idempotency: db.collection<IdempotencyDoc>('api_idempotency'),
    rateLimits: db.collection<RateLimitDoc>('api_rate_limits'),
    usedTokens: db.collection<UsedTokenDoc>('redirect_token_uses'),
  };
}

/** The same keys and uniqueness rules the Postgres tables enforced. */
async function ensureIndexes(c: Collections) {
  await Promise.all([
    c.agencies.createIndex({ id: 1 }, { unique: true }),
    c.agencyMemberships.createIndex({ agency_id: 1, user_id: 1 }, { unique: true }),
    c.agencyMemberships.createIndex({ user_id: 1 }),
    c.subAccounts.createIndex({ id: 1 }, { unique: true }),
    c.subAccounts.createIndex({ client_id: 1 }, { unique: true }),
    c.subAccounts.createIndex({ agency_id: 1, name: 1 }),
    c.subAccountMemberships.createIndex({ sub_account_id: 1, user_id: 1 }, { unique: true }),
    c.subAccountMemberships.createIndex({ user_id: 1 }),
    c.invitations.createIndex({ id: 1 }, { unique: true }),
    c.invitations.createIndex({ token_hash: 1 }, { unique: true }),
    c.invitations.createIndex({ sub_account_id: 1, created_at: -1 }),
    c.jobs.createIndex({ job_id: 1 }, { unique: true }),
    c.reservations.createIndex({ id: 1 }, { unique: true }),
    c.reservations.createIndex({ job_id: 1 }, { unique: true, partialFilterExpression: { job_id: { $type: 'string' } } }),
    c.reservations.createIndex({ sub_account_id: 1, month_key: 1 }),
    c.idempotency.createIndex({ key: 1 }, { unique: true }),
    c.idempotency.createIndex({ created_at: 1 }, { expireAfterSeconds: 24 * 60 * 60 }),
    c.rateLimits.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
    c.usedTokens.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
    c.subAccounts.createIndex({ idempotency_key: 1 }, { partialFilterExpression: { idempotency_key: { $type: 'string' } } }),
  ]);
}

/**
 * Connects (once) before use. When a connection attempt fails, the driver leaves the
 * client permanently closed, so the client is reset here and the next request
 * reconnects instead of failing until the server restarts. The same client object is
 * kept, so Better Auth's reference to it stays valid.
 */
export async function ensureConnected(): Promise<void> {
  const state = getMongo();
  state.connecting ??= state.client.connect().then(
    () => undefined,
    async (error: unknown) => {
      state.connecting = undefined;
      state.indexes = undefined;
      await state.client.close().catch(() => undefined);
      console.error('[MongoDB] Connection failed; the next request will retry', error instanceof Error ? `${error.name}: ${error.message}` : error);
      throw error;
    },
  );
  await state.connecting;
}

/** True for errors that mean the database is unreachable right now (worth retrying). */
export function isDatabaseUnavailable(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  return /^Mongo(ServerSelection|Network|NetworkTimeout|TopologyClosed|NotConnected)Error$/.test(name);
}

export async function collections(): Promise<Collections> {
  await ensureConnected();
  const state = getMongo();
  const c = collectionsFor(state.db);
  state.indexes ??= ensureIndexes(c).catch((error: unknown) => {
    state.indexes = undefined;
    console.error('[MongoDB] Could not create indexes', error);
  });
  await state.indexes;
  return c;
}

/** Runs `fn` in a transaction, retrying on write conflicts. Throwing inside aborts it. */
export async function withTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  await ensureConnected();
  const { client } = getMongo();
  return client.withSession((session) => session.withTransaction(() => fn(session)));
}
