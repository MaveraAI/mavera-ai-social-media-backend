// Branded Mavera AI emails: logo, violet rule, heading, an optional card, numbered steps, one button and a
// black footer. Built with tables and inline styles so they look right in Gmail, Outlook and Apple Mail.
// Every value from users (names, brand names) is escaped before it goes into the HTML.
import { primaryFrontendUrl } from '@/config';

const VIOLET = '#7B2DE8';
const INK = '#0e0c12';
const GREY = '#838382';
const LINE = '#e6e6ea';
const FONT = 'Arial,Helvetica,sans-serif';

const esc = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** The logo lives on the website at a fixed address (EMAIL_LOGO_URL overrides it). */
const logoUrl = () => process.env['EMAIL_LOGO_URL'] || `${primaryFrontendUrl()}/email/mavera-logo.png`;

export type EmailCard = {
  label: string; title?: string; subtitle?: string; ticks?: string[];
  footerLabel?: string; footerLines?: string[];
};
export type EmailContent = {
  subject: string;
  /** Short text shown next to the subject in the inbox list. */
  preheader: string;
  eyebrow: string;
  title: string;
  /** Paragraph text; wrap words in **double stars** to make them bold. */
  intro: string;
  card?: EmailCard;
  steps?: string[];
  button: { label: string; url: string };
  smallPrint: string;
};

/** Escapes text, then turns **bold** into <strong>. */
const rich = (text: string) => esc(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
const plain = (text: string) => text.replace(/\*\*(.+?)\*\*/g, '$1');

function cardHtml(card: EmailCard) {
  const ticks = (card.ticks ?? []).map((t, i, all) =>
    `<p style="margin:0 0 ${i === all.length - 1 ? 18 : 8}px;font-size:15px;line-height:1.5;color:${INK};"><span style="color:${VIOLET};font-weight:bold;">&#10003;</span>&nbsp; ${rich(t)}</p>`).join('');
  const footer = card.footerLabel ? `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-top:1px solid ${LINE};font-size:0;line-height:0;">&nbsp;</td></tr></table>
      <p style="margin:16px 0 8px;font-size:12px;font-weight:bold;letter-spacing:2px;color:${GREY};text-transform:uppercase;">${esc(card.footerLabel)}</p>
      ${(card.footerLines ?? []).map((l, i, all) => `<p style="margin:0 0 ${i === all.length - 1 ? 0 : 4}px;font-size:15px;font-weight:bold;color:${INK};">${rich(l)}</p>`).join('')}` : '';
  return `
  <tr><td style="padding:28px 40px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${VIOLET};border-left:4px solid ${VIOLET};border-radius:10px;">
      <tr><td style="padding:24px 28px;">
        <p style="margin:0 0 6px;font-size:12px;font-weight:bold;letter-spacing:2px;color:${GREY};text-transform:uppercase;">${esc(card.label)}</p>
        ${card.title ? `<p style="margin:0 0 ${card.subtitle ? 4 : 18}px;font-size:20px;font-weight:bold;color:${INK};">${esc(card.title)}</p>` : '<div style="height:8px;line-height:8px;font-size:0;">&nbsp;</div>'}
        ${card.subtitle ? `<p style="margin:0 0 18px;font-size:14px;color:${GREY};">${rich(card.subtitle)}</p>` : ''}
        ${ticks}${footer}
      </td></tr>
    </table>
  </td></tr>`;
}

function stepsHtml(steps: string[]) {
  const rows = steps.map((s, i) => `
      <tr>
        <td valign="top" style="padding:0 14px ${i === steps.length - 1 ? 0 : 14}px 0;"><div style="width:30px;height:30px;border-radius:15px;background:${VIOLET};color:#ffffff;font-size:14px;font-weight:bold;line-height:30px;text-align:center;">${i + 1}</div></td>
        <td valign="top" style="padding:5px 0 ${i === steps.length - 1 ? 0 : 14}px;font-size:15px;line-height:1.5;color:${INK};">${rich(s)}</td>
      </tr>`).join('');
  return `
  <tr><td style="padding:32px 40px 0;">
    <h2 style="margin:0 0 16px;font-size:20px;color:${INK};font-family:${FONT};">What happens next</h2>
    <table role="presentation" cellpadding="0" cellspacing="0">${rows}</table>
  </td></tr>`;
}

/** The HTML and plain-text versions of one branded email. */
export function renderEmail(c: EmailContent): { subject: string; html: string; text: string } {
  const href = esc(c.button.url);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(c.subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f3f7;">
<div style="display:none;max-height:0;overflow:hidden;">${esc(c.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f3f7;"><tr><td align="center" style="padding:32px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;font-family:${FONT};color:${INK};">
  <tr><td style="padding:36px 40px 24px;"><img src="${esc(logoUrl())}" alt="mavera.ai" width="170" style="display:block;width:170px;height:auto;border:0;"></td></tr>
  <tr><td style="height:4px;background:${VIOLET};line-height:4px;font-size:0;">&nbsp;</td></tr>
  <tr><td style="padding:36px 40px 0;">
    <p style="margin:0 0 10px;font-size:13px;font-weight:bold;letter-spacing:2px;color:${VIOLET};text-transform:uppercase;">${esc(c.eyebrow)}</p>
    <h1 style="margin:0 0 18px;font-size:30px;line-height:1.2;color:${INK};font-family:${FONT};">${esc(c.title)}</h1>
    <p style="margin:0;font-size:16px;line-height:1.6;color:${INK};">${rich(c.intro)}</p>
  </td></tr>
  ${c.card ? cardHtml(c.card) : ''}
  ${c.steps?.length ? stepsHtml(c.steps) : ''}
  <tr><td style="padding:28px 40px 0;">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:${VIOLET};border-radius:8px;">
      <a href="${href}" style="display:inline-block;padding:15px 30px;font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;font-family:${FONT};">${esc(c.button.label)}</a>
    </td></tr></table>
    <p style="margin:14px 0 0;font-size:12px;line-height:1.5;color:${GREY};">Button not working? Copy this link into your browser:<br><a href="${href}" style="color:${VIOLET};word-break:break-all;">${href}</a></p>
  </td></tr>
  <tr><td style="padding:24px 40px 36px;"><p style="margin:0;font-size:14px;line-height:1.6;color:${GREY};">${rich(c.smallPrint)}</p></td></tr>
  <tr><td style="background:#000000;padding:28px 40px;">
    <p style="margin:0 0 8px;font-size:16px;font-weight:bold;color:#ffffff;">activate the supercharged version of you.</p>
    <p style="margin:0;font-size:13px;color:${GREY};">Mavera AI &middot; <a href="https://mavera.ai" style="color:#9b5cf0;text-decoration:none;">mavera.ai</a></p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

  const text = [
    c.title, '', plain(c.intro),
    ...(c.card ? ['', c.card.title ? `${c.card.label}: ${c.card.title}` : `${c.card.label}:`, ...(c.card.subtitle ? [plain(c.card.subtitle)] : []), ...(c.card.ticks ?? []).map((t) => `- ${plain(t)}`),
      ...(c.card.footerLabel ? [`${c.card.footerLabel}: ${(c.card.footerLines ?? []).map(plain).join(', ')}`] : [])] : []),
    ...(c.steps?.length ? ['', 'What happens next:', ...c.steps.map((s, i) => `${i + 1}. ${plain(s)}`)] : []),
    '', `${c.button.label}: ${c.button.url}`, '', plain(c.smallPrint), '', 'Mavera AI · https://mavera.ai',
  ].join('\n');
  return { subject: c.subject, html, text };
}

const firstName = (name: string | null | undefined) => (name?.trim() || '').split(/\s+/)[0] || '';
const greeting = (name: string | null | undefined) => (firstName(name) ? `, ${firstName(name)}` : '');

// ---------- The four Mavera emails ----------

export type WelcomeInfo = { name?: string | null; brandName?: string | null; videos?: number; images?: number };

/** Account created through the provisioning API: choose a password. */
export function welcomeEmail(url: string, info: WelcomeInfo = {}) {
  return renderEmail({
    subject: 'Set up your Mavera Socials account',
    preheader: 'Your Mavera Socials account is ready. Choose a password to sign in.',
    eyebrow: 'Your account is ready',
    title: `Welcome to Mavera Socials${greeting(info.name)}`,
    intro: 'Your Mavera Socials account is ready. Choose a password and you can start creating on-brand images and videos straight away.',
    card: {
      label: 'What you get',
      ticks: ['On-brand images, videos and captions from a simple brief', 'Your own photos and PDFs as references', 'Scheduled posting to your connected social accounts'],
      ...(info.videos !== undefined && info.images !== undefined ? { footerLabel: 'Your allowances', footerLines: [`${info.videos} videos per month`, `${info.images} images per month`] } : {}),
    },
    steps: ['Choose your password using the button below.', 'Add your brand details: tone of voice, audience, colours and logo.', 'Connect your social accounts and create your first campaign.'],
    button: { label: 'Set my password', url },
    smallPrint: 'This link works for 1 hour. After that, use "Forgot password?" on the log in page to get a new one. If you didn\'t expect this email, you can ignore it.',
  });
}

/** Someone asked to reset the password. */
export function resetPasswordEmail(url: string, name?: string | null) {
  return renderEmail({
    subject: 'Reset your Mavera AI password',
    preheader: 'Choose a new password for your Mavera AI account.',
    eyebrow: 'Password reset',
    title: `Reset your password${greeting(name)}`,
    intro: 'We received a request to reset the password for your Mavera AI account. Choose a new one using the button below.',
    button: { label: 'Choose a new password', url },
    smallPrint: 'This link works for 1 hour and can be used once. If you didn\'t ask to reset your password, you can ignore this email: your password stays the same.',
  });
}

/** New sign-up: confirm the email address. */
export function confirmEmail(url: string, name?: string | null) {
  return renderEmail({
    subject: 'Confirm your Mavera AI account',
    preheader: 'One click to confirm your email and start using Mavera AI.',
    eyebrow: 'Confirm your email',
    title: `Welcome to Mavera AI${greeting(name)}`,
    intro: 'Thank you for signing up. Please confirm your email address so we know it\'s really you.',
    steps: ['Confirm your email using the button below.', 'Sign in to Mavera AI.', 'Open your brand and create your first campaign.'],
    button: { label: 'Confirm my email', url },
    smallPrint: 'This link works for 1 hour. If it has expired, simply sign in and we\'ll send you a new one. If you didn\'t create an account, you can ignore this email.',
  });
}

/** Invitation to join a brand as an admin or member. */
export function invitationEmail(url: string, brandName: string, role: 'admin' | 'member', expiresAt: Date) {
  const admin = role === 'admin';
  const until = expiresAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });
  return renderEmail({
    subject: `You're invited to ${brandName} on Mavera AI`,
    preheader: `Join ${brandName} on Mavera AI.`,
    eyebrow: 'You\'re invited',
    title: `Join ${brandName} on Mavera AI`,
    intro: `You've been invited to join **${brandName}** on Mavera AI as ${admin ? 'an **administrator**' : 'a **member**'}.`,
    card: {
      label: 'Your access', title: brandName, subtitle: admin ? 'Administrator' : 'Member',
      ticks: admin
        ? ['Create images, videos and captions for the brand', 'Edit the brand profile and connect social accounts', 'Invite and manage the team']
        : ['Create images, videos and captions for the brand', 'Edit and regenerate posts', 'Approve and schedule posts'],
    },
    steps: ['Click **Accept invitation** below.', 'Sign in, or create an account with this email address.', `Start creating content for ${brandName}.`],
    button: { label: 'Accept invitation', url },
    smallPrint: `This invitation works until ${until} and only for this email address. If you weren't expecting it, you can ignore this email.`,
  });
}
