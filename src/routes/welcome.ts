// GET /mavera/welcome?token=<JWT>: where Mavera sends a customer's browser right after payment.
// Always answers with a 302 (never an error page). Only the token query parameter is read;
// there is deliberately no redirect/next parameter.
import { Hono } from 'hono';
import { createPasswordSetupLink } from '@/lib/auth.server';
import { collections } from '@/lib/db/mongo.server';
import { claimJti, findWelcomeAccount, loginUrl, welcomeRedirect, type WelcomeOutcome } from '@/lib/api/welcome.server';
import { primaryFrontendUrl } from '@/config';

/** Stay well inside the ~2 second budget; past this the customer goes to the log in page. */
const TIME_LIMIT_MS = 1800;

function redirect(location: string) {
  return new Response(null, {
    status: 302,
    headers: { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  });
}

export async function handleWelcome(request: Request): Promise<Response> {
  const started = Date.now();
  const frontendUrl = primaryFrontendUrl();
  const token = new URL(request.url).searchParams.get('token') ?? undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ location: string; outcome: WelcomeOutcome; jti?: string }>((resolve) => {
    timer = setTimeout(() => resolve({ location: loginUrl(frontendUrl), outcome: 'timeout' }), TIME_LIMIT_MS);
  });
  const decided = (async () => {
    try {
      return await welcomeRedirect(token, {
        secret: process.env['MAVERA_REDIRECT_SECRET'],
        frontendUrl,
        claimJti: async (jti, expiresAt) => claimJti(await collections(), jti, expiresAt),
        findAccount: async (key, email) => findWelcomeAccount(await collections(), key, email),
        setupLink: createPasswordSetupLink,
      });
    } catch {
      return { location: loginUrl(frontendUrl), outcome: 'error' as const };
    }
  })();
  const result = await Promise.race([decided, timeout]);
  clearTimeout(timer);
  // Never the token or the secret: only the jti and what happened.
  const log = result.outcome === 'set_password' || result.outcome === 'login' ? console.info : console.warn;
  log('[welcome] Redirect', { jti: result.jti ?? null, outcome: result.outcome, durationMs: Date.now() - started });
  if (result.outcome === 'not_configured') console.error('[welcome] MAVERA_REDIRECT_SECRET is not set');
  return redirect(result.location);
}

export const welcome = new Hono();
welcome.get('/welcome', (c) => handleWelcome(c.req.raw));
