// POST /api/public/v1/subaccounts/create
// Creates a user, their sub-account (with the default plan) and the brand profile in one call.
// Auth: Authorization: Bearer <PROVISIONING_API_SECRET>. Optional: Idempotency-Key header.
// Called server-to-server by other platforms (not by the frontend), so it uses a secret, not cookies.
import { Hono } from 'hono';
import { hashPassword } from 'better-auth/crypto';
import * as p from '@/lib/api/provisioning.server';
import { sendPasswordSetupEmail } from '@/lib/auth.server';
import { collections, isDatabaseUnavailable, withTransaction } from '@/lib/db/mongo.server';
import { defaultPlan } from '@/lib/mavera/plans.server';
import { smRequest } from '@/lib/mavera/sm-api.server';

const MAX_BODY_BYTES = 10_000;

function json(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}
const fail = (status: number, message: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  json(status, { success: false, message, ...extra }, headers);

function clientIp(request: Request) {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('x-real-ip')?.trim() || 'unknown';
}

export async function handleCreate(request: Request): Promise<Response> {
  const started = Date.now();
  let email = '';
  try {
    const db = await collections();

    // 1. Rate limit per caller IP, before anything else (also slows down secret guessing).
    const limit = Number(process.env['PROVISIONING_RATE_LIMIT_PER_MINUTE'] || 20);
    const rate = await p.hitRateLimit(db, `provision:${clientIp(request)}`, Number.isFinite(limit) && limit > 0 ? limit : 20);
    if (!rate.allowed) return fail(429, 'Too many requests. Please retry later.', {}, { 'Retry-After': String(rate.retryAfterSeconds) });

    // 2. Authentication.
    if (!p.provisioningConfigured()) {
      console.error('[provisioning] PROVISIONING_API_SECRET is missing or shorter than 32 characters');
      return fail(503, 'This API is not configured yet');
    }
    if (!p.isAuthorized(request.headers.get('authorization'))) return fail(401, 'Unauthorized: Invalid API token');

    // 3. Body.
    if (!(request.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) return fail(415, 'Content-Type must be application/json');
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return fail(413, 'Request body is too large');
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return fail(400, 'Request body must be valid JSON'); }
    const input = p.parseProvisionInput(body);
    email = input.email;

    // 4. Create (once per Idempotency-Key).
    const idempotencyKey = request.headers.get('idempotency-key');
    const result = await p.withIdempotency(db, idempotencyKey, p.requestHash(input), () =>
      p.provisionSubAccount({
        db, tx: withTransaction, sm: smRequest, hashPassword, plan: defaultPlan(),
        agencyId: process.env['PROVISIONING_AGENCY_ID'] || undefined, sendPasswordSetup: sendPasswordSetupEmail,
      }, input, idempotencyKey));

    const data = result.body['data'] as { user_id?: string; account_id?: string } | undefined;
    console.info('[provisioning] Sub-account created', { email: p.maskEmail(email), userId: data?.user_id, accountId: data?.account_id, replayed: !!result.replayed, durationMs: Date.now() - started });
    return json(result.status, result.body, result.replayed ? { 'Idempotent-Replayed': 'true' } : {});
  } catch (error) {
    if (error instanceof p.ApiError) {
      if (error.status >= 500) console.error('[provisioning] Request failed', { status: error.status, message: error.message, email: email ? p.maskEmail(email) : undefined });
      else console.info('[provisioning] Request rejected', { status: error.status, message: error.message, email: email ? p.maskEmail(email) : undefined });
      return fail(error.status, error.message, error.errors ? { errors: error.errors } : {});
    }
    if (isDatabaseUnavailable(error)) {
      console.error('[provisioning] Database unavailable', error instanceof Error ? error.name : error);
      return fail(503, 'The service is temporarily unavailable. Please retry in a moment.', {}, { 'Retry-After': '5' });
    }
    console.error('[provisioning] Unexpected error', error instanceof Error ? `${error.name}: ${error.message}` : error);
    return fail(500, 'Something went wrong. Please retry; repeating the request with the same Idempotency-Key is safe.');
  }
}

export const provisioning = new Hono();
provisioning.post('/subaccounts/create', (c) => handleCreate(c.req.raw));
provisioning.get('/subaccounts/create', () => fail(405, 'Use POST', {}, { Allow: 'POST' }));
