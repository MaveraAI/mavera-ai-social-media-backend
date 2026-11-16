// Runtime settings read from environment variables (see .env.example).

/** Frontend address(es) allowed to call this API with cookies, e.g. https://app.mavera.ai (comma-separated). */
export function frontendOrigins(): string[] {
  const raw = process.env['FRONTEND_URL'] || 'http://localhost:8080';
  return raw.split(',').map((value) => value.trim()).filter(Boolean).map((value) => new URL(value).origin);
}

/** The main frontend address, used in links sent by email (invitations, password setup). */
export function primaryFrontendUrl(): string {
  return frontendOrigins()[0] ?? 'http://localhost:8080';
}

export const isAllowedOrigin = (origin: string | null | undefined) => !!origin && frontendOrigins().includes(origin);

/**
 * Cookie SameSite policy. "lax" when the frontend and API share a site (app.mavera.ai + api.mavera.ai, or
 * localhost ports). "none" only when they are on unrelated domains (e.g. *.pages.dev + *.up.railway.app).
 */
export function cookieSameSite(): 'lax' | 'none' {
  return process.env['COOKIE_SAMESITE']?.toLowerCase() === 'none' ? 'none' : 'lax';
}

export const port = () => Number(process.env['PORT'] || 3000);
