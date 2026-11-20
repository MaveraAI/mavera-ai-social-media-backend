import { afterEach, describe, expect, it, vi } from 'vitest';
import { onboardingViaN8n, sendOnboardingEmail } from './onboarding-mail.server';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const mail = { to: 'customer@example.com', subject: 'Set up your Mavera Socials account', html: '<p>Hi</p>' };

describe('onboarding email through n8n', () => {
  it('is off until the webhook address is set', async () => {
    vi.stubEnv('ONBOARDING_EMAIL_WEBHOOK_URL', '');
    expect(onboardingViaN8n()).toBe(false);
    await expect(sendOnboardingEmail(mail)).resolves.toBe(false);
  });
  it('posts to, subject and html, and trusts only {"sent": true}', async () => {
    vi.stubEnv('ONBOARDING_EMAIL_WEBHOOK_URL', 'https://n8n.example/webhook/onboarding');
    const fetchMock = vi.fn(async () => Response.json({ sent: true, to: mail.to }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(sendOnboardingEmail(mail)).resolves.toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://n8n.example/webhook/onboarding');
    expect(JSON.parse(init.body as string)).toEqual(mail);
  });
  it('reports a failure when n8n refuses, says not sent, or cannot be reached', async () => {
    vi.stubEnv('ONBOARDING_EMAIL_WEBHOOK_URL', 'https://n8n.example/webhook/onboarding');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"message":"html is required"}', { status: 400 })));
    await expect(sendOnboardingEmail(mail)).resolves.toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ sent: false })));
    await expect(sendOnboardingEmail(mail)).resolves.toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    await expect(sendOnboardingEmail(mail)).resolves.toBe(false);
  });
});
