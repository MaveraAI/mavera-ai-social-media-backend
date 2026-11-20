import { describe, expect, it, vi } from 'vitest';
import { confirmEmail, invitationEmail, renderEmail, resetPasswordEmail, welcomeEmail } from './email-template.server';

vi.stubEnv('FRONTEND_URL', 'https://social.mavera.ai');

describe('branded emails', () => {
  it('welcome email shows the brand, admin role, allowances and the set-password button', () => {
    const m = welcomeEmail('https://api.example/reset/abc?callbackURL=x', { name: 'Test User', brandName: 'API Test Brand', videos: 10, images: 30 });
    expect(m.subject).toBe('Welcome to Mavera AI: set your password');
    expect(m.html).toContain('Welcome to Mavera AI, Test');
    expect(m.html).toContain('<strong>API Test Brand</strong>');
    expect(m.html).toContain('You are the brand administrator');
    expect(m.html).toContain('10 videos per month');
    expect(m.html).toContain('30 images per month');
    expect(m.html).toContain('href="https://api.example/reset/abc?callbackURL=x"');
    expect(m.html).toContain('https://social.mavera.ai/email/mavera-logo.png');
    expect(m.html).toContain('activate the supercharged version of you.');
    expect(m.text).toContain('Set my password: https://api.example/reset/abc?callbackURL=x');
  });

  it('confirm, reset and invitation emails have their own heading and button', () => {
    expect(confirmEmail('https://x/verify', 'Shahid Satti').html).toMatch(/Welcome to Mavera AI, Shahid[\s\S]*Confirm my email/);
    expect(resetPasswordEmail('https://x/reset', null).html).toMatch(/Reset your password<[\s\S]*Choose a new password/);
    const invite = invitationEmail('https://social.mavera.ai/invite?token=t', 'Mavera Internal', 'member', new Date('2026-11-26T12:00:00Z'));
    expect(invite.subject).toBe("You're invited to Mavera Internal on Mavera AI");
    expect(invite.html).toContain('as a <strong>member</strong>');
    expect(invite.html).toContain('Approve and schedule posts');
    expect(invite.html).toContain('works until 26 November 2026');
    expect(invitationEmail('https://x', 'Acme', 'admin', new Date()).html).toContain('Invite and manage the team');
  });

  it('escapes names and brand names so nobody can inject HTML into an email', () => {
    const m = welcomeEmail('https://x/"><script>', { name: '<img src=x onerror=alert(1)>', brandName: 'Evil <b>Brand</b>', videos: 1, images: 1 });
    expect(m.html).not.toContain('<img src=x');
    expect(m.html).not.toContain('<b>Brand</b>');
    expect(m.html).toContain('Evil &lt;b&gt;Brand&lt;/b&gt;');
    expect(m.html).toContain('href="https://x/&quot;&gt;&lt;script&gt;"');
  });

  it('leaves the brand card out when there is no brand', () => {
    const m = welcomeEmail('https://x');
    expect(m.html).not.toContain('Your brand');
    expect(m.html).toContain('Welcome to Mavera AI</h1>');
    expect(renderEmail({ subject: 's', preheader: 'p', eyebrow: 'e', title: 't', intro: 'i', button: { label: 'b', url: 'https://x' }, smallPrint: 'sp' }).html).not.toContain('What happens next');
  });
});
