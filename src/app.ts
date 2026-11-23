// The HTTP application: CORS for the frontend, Better Auth, the REST API and the public provisioning API.
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { errorToResponse } from '@/http';
import { auth } from '@/lib/auth.server';
import { ensureConnected } from '@/lib/db/mongo.server';
import { frontendOrigins } from '@/config';
import { provisioning } from '@/routes/provisioning';
import { v1 } from '@/routes/v1';
import { welcome } from '@/routes/welcome';

export const app = new Hono();

app.use('*', secureHeaders());
// Only the frontend(s) in FRONTEND_URL may call the API from a browser, with cookies.
app.use('*', cors({
  origin: (origin) => (frontendOrigins().includes(origin) ? origin : null),
  credentials: true,
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
  maxAge: 600,
}));

app.get('/', (c) => c.json({ name: 'Mavera AI API', status: 'ok' }));
app.get('/health', async (c) => {
  try { await ensureConnected(); return c.json({ ok: true, database: 'connected' }); }
  catch { return c.json({ ok: false, database: 'unavailable' }, 503); }
});

// Better Auth: sign up, sign in, sessions, email verification, password reset.
app.on(['GET', 'POST'], '/api/auth/*', async (c) => {
  try { await ensureConnected(); } catch {
    return c.json({ message: 'The service is temporarily unavailable. Please try again in a moment.', code: 'DATABASE_UNAVAILABLE' }, 503, { 'Retry-After': '5' });
  }
  return auth.handler(c.req.raw);
});

app.route('/v1', v1);
app.route('/api/public/v1', provisioning);
// Mavera's post-payment redirect: sends the customer to set their password or to log in.
app.route('/mavera', welcome);

app.notFound((c) => c.json({ message: 'Not found' }, 404));
app.onError((error, c) => {
  const { status, message } = errorToResponse(error);
  // One line per failed request so a 400 can be traced from the server logs.
  if (status !== 401) console.warn(`[api] ${c.req.method} ${c.req.path} -> ${status}: ${message}`);
  return c.json({ message }, status as 400);
});
