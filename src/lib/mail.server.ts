// Server-only email sending through Resend's HTTP API (https://resend.com).
// Set RESEND_API_KEY and MAIL_FROM (e.g. "Mavera AI <hello@mavera.ai>") to enable it.
// Without them, development logs the message to the server console so links can
// still be tested; production only logs that email is not configured.
export type Mail = { to: string; subject: string; text: string; html?: string };

export async function sendMail(mail: Mail): Promise<boolean> {
  const key = process.env['RESEND_API_KEY'];
  const from = process.env['MAIL_FROM'];
  if (!key || !from) {
    if (process.env['NODE_ENV'] !== 'production') {
      console.warn(`[mail] Email sending is not configured. Would send to ${mail.to}: "${mail.subject}"\n${mail.text}`);
    } else {
      console.error('[mail] Email sending is not configured (RESEND_API_KEY / MAIL_FROM missing).');
    }
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: mail.to, subject: mail.subject, text: mail.text, ...(mail.html ? { html: mail.html } : {}) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.error(`[mail] Sending failed with status ${res.status}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error('[mail] Sending failed', error instanceof Error ? error.name : error);
    return false;
  }
}

export function linkEmail(intro: string, url: string, action: string): Pick<Mail, 'text' | 'html'> {
  const safeUrl = url.replace(/"/g, '%22');
  return {
    text: `${intro}\n\n${action}: ${url}\n\nIf you didn't expect this email, you can ignore it.`,
    html: `<p>${intro}</p><p><a href="${safeUrl}">${action}</a></p><p>If you didn't expect this email, you can ignore it.</p>`,
  };
}
