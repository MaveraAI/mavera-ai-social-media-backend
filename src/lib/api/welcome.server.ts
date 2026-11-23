// Server-only: GET /mavera/welcome?token=<JWT>
// After a customer pays, Mavera creates their sub-account (provisioning API, Idempotency-Key
// mavera-tenant-<tenantId>) and sends their browser here with a short-lived signed token.
// We only ever redirect: to a fresh set-password link (first visit) or to the log in page.
// The token never signs anyone in, and it is never logged (only its jti and the outcome).
import { errors, jwtVerify } from 'jose';
import { z } from 'zod';
import type { Collections } from '@/lib/db/mongo.server';

export const WELCOME_ISSUER = 'mavera-ai';
export const WELCOME_AUDIENCE = 'mavera-socials';
const CLOCK_SKEW_SECONDS = 60;

const claimsSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  idempotency_key: z.string().max(200).optional(),
  jti: z.string().min(1).max(200),
  exp: z.number(),
});

export type WelcomeAccount = { email: string; passwordSetupPending: boolean };
export type WelcomeOutcome =
  | 'set_password' | 'login' | 'missing_token' | 'not_configured' | 'invalid_token' | 'expired'
  | 'reused' | 'account_not_found' | 'link_failed' | 'error' | 'timeout';

export type WelcomeDeps = {
  /** MAVERA_REDIRECT_SECRET */
  secret: string | undefined;
  /** Frontend origin, e.g. https://social.mavera.ai */
  frontendUrl: string;
  /** Records the jti until the token expires; false when it was already used. */
  claimJti: (jti: string, expiresAt: Date) => Promise<boolean>;
  findAccount: (idempotencyKey: string | undefined, email: string) => Promise<WelcomeAccount | null>;
  /** A fresh set-password link (same mechanism as the onboarding email), or null. */
  setupLink: (email: string) => Promise<string | null>;
  now?: () => Date;
};

export const loginUrl = (frontendUrl: string, email?: string) =>
  `${frontendUrl}/auth${email ? `?email=${encodeURIComponent(email)}` : ''}`;

/** Decides where to send the browser. Never throws: anything unexpected falls back to the log in page. */
export async function welcomeRedirect(token: string | undefined, deps: WelcomeDeps): Promise<{ location: string; outcome: WelcomeOutcome; jti?: string }> {
  const fallback = (outcome: WelcomeOutcome, jti?: string) => ({ location: loginUrl(deps.frontendUrl), outcome, ...(jti ? { jti } : {}) });
  if (!token || token.length > 4096) return fallback('missing_token');
  if (!deps.secret) return fallback('not_configured');

  let claims: z.infer<typeof claimsSchema>;
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(deps.secret), {
      algorithms: ['HS256'],
      issuer: WELCOME_ISSUER,
      audience: WELCOME_AUDIENCE,
      clockTolerance: CLOCK_SKEW_SECONDS,
      requiredClaims: ['exp', 'jti'],
      ...(deps.now ? { currentDate: deps.now() } : {}),
    });
    const parsed = claimsSchema.safeParse(payload);
    if (!parsed.success) return fallback('invalid_token', typeof payload.jti === 'string' ? payload.jti : undefined);
    claims = parsed.data;
  } catch (error) {
    return fallback(error instanceof errors.JWTExpired ? 'expired' : 'invalid_token');
  }

  const { jti } = claims;
  try {
    // Kept until the token can no longer be used (expiry plus the allowed clock skew).
    if (!(await deps.claimJti(jti, new Date((claims.exp + CLOCK_SKEW_SECONDS) * 1000)))) return fallback('reused', jti);
    const account = await deps.findAccount(claims.idempotency_key, claims.email);
    if (!account) return fallback('account_not_found', jti);
    if (account.passwordSetupPending) {
      const link = await deps.setupLink(account.email);
      // Without a link, the log in page (with "Forgot password?") is still a safe place to land.
      return link ? { location: link, outcome: 'set_password', jti } : { location: loginUrl(deps.frontendUrl, account.email), outcome: 'link_failed', jti };
    }
    return { location: loginUrl(deps.frontendUrl, account.email), outcome: 'login', jti };
  } catch {
    return fallback('error', jti);
  }
}

const isDuplicateKey = (error: unknown) => !!error && typeof error === 'object' && 'code' in error && (error as { code: unknown }).code === 11000;

/** One use per jti: the insert fails on the unique _id when the token was already used. */
export async function claimJti(db: Collections, jti: string, expiresAt: Date): Promise<boolean> {
  try {
    await db.usedTokens.insertOne({ _id: jti, expires_at: expiresAt });
    return true;
  } catch (error) {
    if (isDuplicateKey(error)) return false;
    throw error;
  }
}

/**
 * The account Mavera created: by the provisioning Idempotency-Key (stored on the sub-account,
 * or the stored provisioning result for accounts created before that), else by email (any case).
 */
export async function findWelcomeAccount(db: Collections, idempotencyKey: string | undefined, email: string): Promise<WelcomeAccount | null> {
  let userId: string | undefined;
  if (idempotencyKey) {
    const sub = await db.subAccounts.findOne({ idempotency_key: idempotencyKey });
    if (sub) userId = (await db.subAccountMemberships.findOne({ sub_account_id: sub.id, role: 'admin', revoked_at: null }))?.user_id;
    if (!userId) {
      const stored = await db.idempotency.findOne({ key: idempotencyKey, state: 'done' });
      const data = (stored?.body as { data?: { user_id?: unknown } } | undefined)?.data;
      if (typeof data?.user_id === 'string') userId = data.user_id;
    }
  }
  const user = userId
    ? await db.users.findOne({ _id: userId })
    : (await db.users.findOne({ email })) ?? (await db.users.findOne({ email }, { collation: { locale: 'en', strength: 2 } }));
  if (!user) return null;
  return { email: user.email, passwordSetupPending: user.password_setup_pending === true };
}
