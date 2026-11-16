// Server-only Better Auth instance. Users, sessions and verification tokens live
// in MongoDB (collections: user, account, session, verification).
import { betterAuth } from 'better-auth';
import { mongodbAdapter } from 'better-auth/adapters/mongodb';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import bcrypt from 'bcryptjs';
import { getMongo } from '@/lib/db/mongo.server';
import { linkEmail, sendMail } from '@/lib/mail.server';
import { cookieSameSite, frontendOrigins, primaryFrontendUrl } from '@/config';

const { client, db } = getMongo();
// BETTER_AUTH_URL is this API's public address (e.g. https://api.mavera.ai); the frontend lives elsewhere.
const secureCookies = (process.env['BETTER_AUTH_URL'] ?? '').startsWith('https://');

/** Emails currently being sent a welcome "set your password" link instead of a reset notice, with whether it was sent. */
const welcomeEmails = new Map<string, boolean | undefined>();

export const auth = betterAuth({
  appName: 'Mavera AI',
  secret: process.env['BETTER_AUTH_SECRET'],
  baseURL: process.env['BETTER_AUTH_URL'],
  database: mongodbAdapter(db, { client }),
  // The frontend calls this API from its own address; only those origins may use it,
  // and callback/redirect links may only point back to them.
  trustedOrigins: frontendOrigins(),
  advanced: {
    // UUID strings, so users imported from the old Supabase database keep their IDs
    // and every membership row that points at them stays valid.
    database: { generateId: () => crypto.randomUUID() },
    useSecureCookies: secureCookies,
    defaultCookieAttributes: { sameSite: cookieSameSite(), secure: secureCookies || cookieSameSite() === 'none', httpOnly: true },
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    // Supabase allowed 6-character passwords; keep existing accounts able to sign in.
    minPasswordLength: 6,
    maxPasswordLength: 128,
    revokeSessionsOnPasswordReset: true,
    password: {
      hash: hashPassword,
      // Imported Supabase users have bcrypt hashes ($2a$/$2b$); new ones use Better Auth's scrypt.
      verify: async ({ hash, password }) =>
        hash.startsWith('$2') ? bcrypt.compare(password, hash) : verifyPassword({ hash, password }),
    },
    sendResetPassword: async ({ user, url }) => {
      if (welcomeEmails.has(user.email)) {
        const sent = await sendMail({
          to: user.email, subject: 'Welcome to Mavera AI: set your password',
          ...linkEmail('Your Mavera AI account is ready. Choose a password to sign in. The link works for 1 hour; after that, use "Forgot password?" on the log in page to get a new one.', url, 'Set my password'),
        });
        welcomeEmails.set(user.email, sent);
        return;
      }
      await sendMail({ to: user.email, subject: 'Reset your Mavera AI password', ...linkEmail('Someone asked to reset the password for your Mavera AI account.', url, 'Choose a new password') });
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    // A login attempt by an unconfirmed user sends a fresh link, so a lost or expired one is never a dead end.
    sendOnSignIn: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      await sendMail({ to: user.email, subject: 'Confirm your Mavera AI account', ...linkEmail('Welcome to Mavera AI. Please confirm your email address.', url, 'Confirm my email') });
    },
  },
});

/** Emails a newly provisioned user a secure link to choose their password. Returns whether the email was sent. */
export async function sendPasswordSetupEmail(email: string): Promise<boolean> {
  welcomeEmails.set(email, undefined);
  try {
    await auth.api.requestPasswordReset({ body: { email, redirectTo: `${primaryFrontendUrl()}/reset-password` } });
    return welcomeEmails.get(email) === true;
  } catch (error) {
    console.error('[auth] Could not send the password setup email', error instanceof Error ? error.message : error);
    return false;
  } finally {
    welcomeEmails.delete(email);
  }
}
