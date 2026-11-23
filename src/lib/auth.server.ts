// Server-only Better Auth instance. Users, sessions and verification tokens live
// in MongoDB (collections: user, account, session, verification).
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { mongodbAdapter } from 'better-auth/adapters/mongodb';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import bcrypt from 'bcryptjs';
import { collections, getMongo, withTransaction } from '@/lib/db/mongo.server';
import { AccountDeletionBlocked, hasPendingInvitation, leaveAllAccounts } from '@/lib/mavera/tenant.server';
import { sendMail } from '@/lib/mail.server';
import { onboardingViaN8n, sendOnboardingEmail } from '@/lib/onboarding-mail.server';
import { accountDeletedEmail, confirmEmail, resetPasswordEmail, welcomeEmail, type WelcomeInfo } from '@/lib/email-template.server';
import { cookieSameSite, frontendOrigins, primaryFrontendUrl } from '@/config';

const { client, db } = getMongo();
// BETTER_AUTH_URL is this API's public address (e.g. https://api.mavera.ai); the frontend lives elsewhere.
const secureCookies = (process.env['BETTER_AUTH_URL'] ?? '').startsWith('https://');

/** Emails currently being sent a welcome "set your password" link instead of a reset notice: who they are, and whether it was sent. */
const welcomeEmails = new Map<string, { info: WelcomeInfo; sent?: boolean }>();

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
      const welcome = welcomeEmails.get(user.email);
      if (welcome) {
        const mail = welcomeEmail(url, { name: user.name, ...welcome.info });
        // Onboarding goes out through n8n (from maverick@mavera.ai) when configured, otherwise through Resend.
        welcome.sent = onboardingViaN8n()
          ? await sendOnboardingEmail({ to: user.email, subject: mail.subject, html: mail.html })
          : await sendMail({ to: user.email, ...mail });
        return;
      }
      await sendMail({ to: user.email, ...resetPasswordEmail(url, user.name) });
    },
  },
  // Sign-up is invitation-only (accounts are created through the provisioning API).
  // "Delete my account": always needs the current password, and never leaves a brand without an administrator.
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === '/sign-up/email') {
        const email = typeof ctx.body?.email === 'string' ? ctx.body.email : '';
        if (!email || !(await hasPendingInvitation(await collections(), email))) {
          throw new APIError('BAD_REQUEST', { message: 'Accounts are set up by Mavera. If you were invited, use the email address the invitation was sent to.', code: 'SIGN_UP_INVITE_ONLY' });
        }
      }
      if (ctx.path === '/delete-user' && (typeof ctx.body?.password !== 'string' || !ctx.body.password || ctx.body.token)) {
        throw new APIError('BAD_REQUEST', { message: 'Enter your password to delete your account' });
      }
    }),
  },
  user: {
    deleteUser: {
      enabled: true,
      beforeDelete: async (user) => {
        try {
          await leaveAllAccounts(await collections(), withTransaction, { id: user.id, email: user.email });
        } catch (error) {
          if (error instanceof AccountDeletionBlocked) throw new APIError('BAD_REQUEST', { message: error.message });
          console.error('[auth] Account deletion failed', error instanceof Error ? error.message : error);
          throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Could not delete your account. Please try again.' });
        }
      },
      afterDelete: async (user) => {
        await sendMail({ to: user.email, ...accountDeletedEmail(user.name) }).catch(() => false);
      },
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    // A login attempt by an unconfirmed user sends a fresh link, so a lost or expired one is never a dead end.
    sendOnSignIn: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      await sendMail({ to: user.email, ...confirmEmail(url, user.name) });
    },
  },
});

/** Emails a newly provisioned user a secure link to choose their password. Returns whether the email was sent. */
export async function sendPasswordSetupEmail(email: string, info: WelcomeInfo = {}): Promise<boolean> {
  const entry: { info: WelcomeInfo; sent?: boolean } = { info };
  welcomeEmails.set(email, entry);
  try {
    await auth.api.requestPasswordReset({ body: { email, redirectTo: `${primaryFrontendUrl()}/reset-password` } });
    return entry.sent === true;
  } catch (error) {
    console.error('[auth] Could not send the password setup email', error instanceof Error ? error.message : error);
    return false;
  } finally {
    welcomeEmails.delete(email);
  }
}
