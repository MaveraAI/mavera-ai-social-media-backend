// Server-only: automatic sub-account creation for trusted external platforms.
// Used by POST /api/public/v1/subaccounts/create.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { ClientSession } from 'mongodb';
import { z } from 'zod';
import type { Collections } from '@/lib/db/mongo.server';
import type { Plan } from '@/lib/mavera/plans.server';
import { NEW_BRAND_DEFAULTS, slugify, type Brand } from '@/lib/mavera/sm-shared';

export class ApiError extends Error {
  constructor(public status: number, message: string, public errors?: string[]) { super(message); }
}

// ---------- Authentication ----------
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();

/** Bearer token check against PROVISIONING_API_SECRET (and _PREVIOUS during rotation), in constant time. */
export function isAuthorized(authorization: string | null, env: Record<string, string | undefined> = process.env): boolean {
  const current = env['PROVISIONING_API_SECRET'];
  if (!current) return false;
  const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')?.[1];
  if (!token) return false;
  const provided = digest(token);
  const matches = (secret?: string) => !!secret && timingSafeEqual(provided, digest(secret));
  return matches(current) || matches(env['PROVISIONING_API_SECRET_PREVIOUS']);
}
export const provisioningConfigured = (env: Record<string, string | undefined> = process.env) => (env['PROVISIONING_API_SECRET']?.length ?? 0) >= 32;

// ---------- Input ----------
const validTimezone = (tz: string) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }).format(); return true; } catch { return false; } };

export const provisionSchema = z.object({
  user_name: z.string({ error: 'user_name is required and must be text' }).trim().min(1, 'user_name is required').max(120, 'user_name must be 120 characters or fewer'),
  email: z.string({ error: 'email is required and must be text' }).trim().toLowerCase().email('email must be a valid email address').max(254, 'email is too long'),
  brand_name: z.string({ error: 'brand_name is required and must be text' }).trim().min(1, 'brand_name is required').max(120, 'brand_name must be 120 characters or fewer'),
  /** Optional permanent brand ID; generated from brand_name when omitted (same rule as the brand form). */
  client_id: z.string({ error: 'client_id must be text' }).regex(/^[a-z0-9-]{2,50}$/, 'client_id must be 2-50 lowercase letters, numbers or dashes').optional(),
  timezone: z.string({ error: 'timezone must be text' }).max(60).refine(validTimezone, 'timezone must be a valid IANA timezone, e.g. Europe/London').optional(),
});
export type ProvisionInput = z.infer<typeof provisionSchema>;

export function parseProvisionInput(body: unknown): ProvisionInput {
  const result = provisionSchema.safeParse(body);
  if (!result.success) throw new ApiError(400, 'Invalid request body', result.error.issues.map((i) => i.message));
  return result.data;
}

// ---------- Rate limiting (fixed one-minute window, shared across server instances via MongoDB) ----------
export async function hitRateLimit(db: Collections, key: string, limit: number, now = Date.now()) {
  const windowMs = 60_000;
  const window = Math.floor(now / windowMs);
  const doc = await db.rateLimits.findOneAndUpdate(
    { _id: `${key}:${window}` },
    { $inc: { count: 1 }, $setOnInsert: { expires_at: new Date((window + 2) * windowMs) } },
    { upsert: true, returnDocument: 'after' },
  );
  const count = doc?.count ?? 1;
  return { allowed: count <= limit, retryAfterSeconds: Math.ceil(((window + 1) * windowMs - now) / 1000) };
}

// ---------- Idempotency ----------
export type ApiResult = { status: number; body: Record<string, unknown> };
const isDuplicateKey = (error: unknown) => !!error && typeof error === 'object' && 'code' in error && (error as { code: unknown }).code === 11000;

export function requestHash(input: ProvisionInput) {
  return createHash('sha256').update(JSON.stringify([input.user_name, input.email, input.brand_name, input.client_id ?? null, input.timezone ?? null])).digest('hex');
}

/** Same key + same body replays the stored success; same key + different body is rejected. */
export async function withIdempotency(db: Collections, key: string | null, hash: string, run: () => Promise<ApiResult>): Promise<ApiResult & { replayed?: boolean }> {
  if (!key) return run();
  if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(key)) throw new ApiError(400, 'Idempotency-Key must be 1-200 letters, numbers, dashes, underscores, dots or colons');
  try {
    await db.idempotency.insertOne({ key, request_hash: hash, state: 'pending', created_at: new Date() });
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    const existing = await db.idempotency.findOne({ key });
    if (!existing) throw new ApiError(409, 'A request with this Idempotency-Key is still being processed. Retry shortly.');
    if (existing.request_hash !== hash) throw new ApiError(422, 'This Idempotency-Key was already used with a different request body');
    if (existing.state !== 'done' || existing.status === undefined) throw new ApiError(409, 'A request with this Idempotency-Key is still being processed. Retry shortly.');
    return { status: existing.status, body: existing.body as Record<string, unknown>, replayed: true };
  }
  try {
    const result = await run();
    // Only successes are stored; a failed request can be retried with the same key.
    if (result.status >= 200 && result.status < 300) await db.idempotency.updateOne({ key }, { $set: { state: 'done', status: result.status, body: result.body } });
    else await db.idempotency.deleteOne({ key });
    return result;
  } catch (error) {
    await db.idempotency.deleteOne({ key }).catch(() => undefined);
    throw error;
  }
}

// ---------- Provisioning ----------
export type ProvisionDeps = {
  db: Collections;
  tx: <T>(fn: (session: ClientSession) => Promise<T>) => Promise<T>;
  sm: <T>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>;
  hashPassword: (password: string) => Promise<string>;
  plan: Plan;
  agencyId: string | undefined;
  sendPasswordSetup: (email: string, info: { name: string; brandName: string; videos: number; images: number }) => Promise<boolean>;
};

/** PROVISIONING_AGENCY_ID, or the only agency when there is exactly one. */
export async function resolveAgencyId(db: Collections, configured: string | undefined) {
  if (configured) {
    if (!(await db.agencies.findOne({ id: configured }))) throw new ApiError(500, 'Provisioning is not configured correctly');
    return configured;
  }
  const agencies = await db.agencies.find({}, { projection: { id: 1 } }).limit(2).toArray();
  if (agencies.length !== 1 || !agencies[0]) throw new ApiError(500, 'Provisioning is not configured correctly');
  return agencies[0].id;
}

export async function provisionSubAccount(deps: ProvisionDeps, input: ProvisionInput, idempotencyKey: string | null = null): Promise<ApiResult> {
  const { db } = deps;
  const email = input.email;
  const clientId = input.client_id ?? slugify(input.brand_name);
  if (clientId.length < 2) throw new ApiError(400, 'Invalid request body', ['brand_name must contain at least 2 letters or numbers']);
  const timezone = input.timezone ?? NEW_BRAND_DEFAULTS.timezone;

  // Duplicate checks (unique indexes enforce them again inside the transaction).
  if (await db.users.findOne({ email })) throw new ApiError(409, 'An account already exists for this email');
  if (await db.subAccounts.findOne({ client_id: clientId })) throw new ApiError(409, 'A sub-account already exists for this brand. Use a different brand_name or client_id.');
  const agencyId = await resolveAgencyId(db, deps.agencyId);
  const upstream = await deps.sm<{ brands?: Brand[] }>(`sm/brands?client_id=${encodeURIComponent(clientId)}`);
  if (upstream.brands?.some((b) => b.client_id === clientId)) throw new ApiError(409, 'A brand with this ID already exists. Use a different brand_name or client_id.');

  const now = new Date();
  const userId = crypto.randomUUID();
  const accountId = crypto.randomUUID();
  // Unguessable password nobody knows; the user sets their own through the emailed link.
  const passwordHash = await deps.hashPassword(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'));

  try {
    await deps.tx(async (session) => {
      await db.users.insertOne({ _id: userId, name: input.user_name, email, emailVerified: true, image: null, createdAt: now, updatedAt: now, password_setup_pending: true }, { session });
      await db.authAccounts.insertOne({ _id: crypto.randomUUID(), accountId: userId, providerId: 'credential', userId, password: passwordHash, createdAt: now, updatedAt: now }, { session });
      await db.subAccounts.insertOne({ id: accountId, agency_id: agencyId, client_id: clientId, name: input.brand_name, timezone, monthly_video_limit: deps.plan.monthly_video_limit, monthly_image_limit: deps.plan.monthly_image_limit, created_at: now, idempotency_key: idempotencyKey }, { session });
      await db.subAccountMemberships.insertOne({ sub_account_id: accountId, user_id: userId, role: 'admin', revoked_at: null }, { session });
    });
  } catch (error) {
    if (isDuplicateKey(error)) throw new ApiError(409, 'An account or brand with these details already exists');
    throw error;
  }

  // The brand profile lives in the content service. If it can't be created, undo the
  // account so no half-created sub-account is left behind.
  try {
    await deps.sm('sm/brands', { method: 'POST', body: { client_id: clientId, name: input.brand_name, ...NEW_BRAND_DEFAULTS, timezone } });
  } catch (error) {
    await deps.tx(async (session) => {
      await db.subAccountMemberships.deleteMany({ sub_account_id: accountId }, { session });
      await db.subAccounts.deleteOne({ id: accountId }, { session });
      await db.authAccounts.deleteMany({ userId }, { session });
      await db.users.deleteOne({ _id: userId }, { session });
    });
    console.error('[provisioning] Brand profile creation failed; account rolled back', error instanceof Error ? error.message : error);
    throw new ApiError(502, 'Could not create the brand profile. Nothing was created; please retry.');
  }

  const emailed = await deps.sendPasswordSetup(email, {
    name: input.user_name, brandName: input.brand_name, videos: deps.plan.monthly_video_limit, images: deps.plan.monthly_image_limit,
  }).catch(() => false);
  return {
    status: 201,
    body: {
      success: true,
      message: 'Sub-account created successfully',
      data: {
        user_id: userId,
        account_id: accountId,
        client_id: clientId,
        brand_name: input.brand_name,
        plan: deps.plan.name,
        monthly_video_limit: deps.plan.monthly_video_limit,
        monthly_image_limit: deps.plan.monthly_image_limit,
        password_setup_email_sent: emailed,
      },
    },
  };
}

/** For logs: j***@example.com */
export const maskEmail = (email: string) => email.replace(/^(.).*@/, '$1***@');
