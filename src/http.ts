// Shared HTTP helpers: who is calling, and turning errors into JSON responses.
import type { Context, MiddlewareHandler } from 'hono';
import { auth } from '@/lib/auth.server';
import { collections, isDatabaseUnavailable, type Collections } from '@/lib/db/mongo.server';
import { isAllowedOrigin } from '@/config';

export type AuthContext = { db: Collections; userId: string; user: { id: string; email: string; emailVerified: boolean } };
export type AppEnv = { Variables: { auth: AuthContext } };

export class HttpError extends Error {
  constructor(public status: 400 | 401 | 403 | 404 | 409 | 503, message: string) { super(message); }
}

/** Requires a signed-in user (Better Auth session cookie) and exposes the MongoDB collections. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const db = await collections();
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) throw new HttpError(401, 'Unauthorized: Please sign in again');
  c.set('auth', { db, userId: session.user.id, user: { id: session.user.id, email: session.user.email, emailVerified: session.user.emailVerified } });
  await next();
};

/**
 * Cookie-authenticated changes must come from the frontend itself (CSRF protection on top of
 * SameSite cookies and CORS): the browser's Origin header has to be one of FRONTEND_URL.
 */
export const requireTrustedOrigin: MiddlewareHandler = async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && !isAllowedOrigin(c.req.header('origin'))) {
    throw new HttpError(403, 'Forbidden: request did not come from the Mavera app');
  }
  await next();
};

/** JSON body of a request; an empty body becomes {}. */
export async function readJson(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'Request body must be valid JSON'); }
}

/** One error format for the whole API: { message }. */
export function errorToResponse(error: unknown): { status: number; message: string } {
  if (error instanceof HttpError) return { status: error.status, message: error.message };
  if (isDatabaseUnavailable(error)) return { status: 503, message: 'The service is temporarily unavailable. Please try again in a moment.' };
  if (error instanceof Error) {
    // Database and driver internals are never shown to users.
    if (/^Mongo/.test(error.name)) {
      console.error('[api] Database error', `${error.name}: ${error.message}`);
      return { status: 500, message: 'Something went wrong. Please retry.' };
    }
    if (/^Unauthorized/.test(error.message)) return { status: 401, message: error.message };
    if (/access denied|access required/i.test(error.message)) return { status: 403, message: error.message };
    // Our own validation and business-rule messages are written for users.
    return { status: 400, message: error.message };
  }
  console.error('[api] Unexpected error', error);
  return { status: 500, message: 'Something went wrong. Please retry.' };
}
