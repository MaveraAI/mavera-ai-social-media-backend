// The Mavera Socials onboarding email (account created through the provisioning API) goes out through
// n8n, from maverick@mavera.ai as "Mavera AI", so customer replies reach that inbox.
// The webhook has no key, so its address lives only in ONBOARDING_EMAIL_WEBHOOK_URL (server-side).
const mask = (email: string) => email.replace(/^(.).*@/, '$1***@');

/** True when the onboarding email should go through n8n instead of Resend. */
export const onboardingViaN8n = () => !!process.env['ONBOARDING_EMAIL_WEBHOOK_URL'];

/** Sends the already-personalised email through n8n. Returns whether n8n confirmed it was sent. */
export async function sendOnboardingEmail(mail: { to: string; subject: string; html: string }): Promise<boolean> {
  const url = process.env['ONBOARDING_EMAIL_WEBHOOK_URL'];
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: mail.to, subject: mail.subject, html: mail.html }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.json().catch(() => ({})) as { sent?: boolean };
    if (!res.ok || body.sent !== true) {
      console.error(`[mail] Onboarding email via n8n failed for ${mask(mail.to)} (status ${res.status})`);
      return false;
    }
    console.info(`[mail] Onboarding email sent via n8n to ${mask(mail.to)}`);
    return true;
  } catch (error) {
    console.error(`[mail] Onboarding email via n8n failed for ${mask(mail.to)}`, error instanceof Error ? error.name : error);
    return false;
  }
}
