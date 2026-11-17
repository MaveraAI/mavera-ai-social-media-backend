// REST API used by the frontend. All routes need a signed-in user; changes must come from the frontend's origin.
import { Hono } from 'hono';
import { readJson, requireAuth, requireTrustedOrigin, type AppEnv } from '@/http';
import * as connections from '@/services/connections';
import * as content from '@/services/content';
import * as tenant from '@/services/tenant';

export const v1 = new Hono<AppEnv>();
v1.use('*', requireTrustedOrigin, requireAuth);

const obj = (value: unknown) => (value && typeof value === 'object' ? value as Record<string, unknown> : {});

// ---------- Sub-accounts, usage, members, invitations ----------
v1.get('/accounts', async (c) => c.json(await tenant.listAccounts(c.var.auth)));
v1.get('/accounts/:accountId/usage', async (c) => c.json(await tenant.accountUsage(c.var.auth, { account_id: c.req.param('accountId') })));
v1.put('/accounts/:accountId/video-limit', async (c) =>
  c.json(await tenant.setVideoLimit(c.var.auth, { ...obj(await readJson(c)), account_id: c.req.param('accountId') })));
v1.get('/accounts/:accountId/people', async (c) => c.json(await tenant.accountPeople(c.var.auth, { account_id: c.req.param('accountId') })));
v1.post('/accounts/:accountId/members/:userId', async (c) =>
  c.json(await tenant.changeMember(c.var.auth, { ...obj(await readJson(c)), account_id: c.req.param('accountId'), user_id: c.req.param('userId') })));
v1.post('/accounts/:accountId/invitations', async (c) =>
  c.json(await tenant.inviteMember(c.var.auth, { ...obj(await readJson(c)), account_id: c.req.param('accountId') })));
v1.delete('/accounts/:accountId/invitations/:invitationId', async (c) =>
  c.json(await tenant.revokeInvitation(c.var.auth, { account_id: c.req.param('accountId'), invitation_id: c.req.param('invitationId') })));
// Tokens travel in the body, never in URLs (which end up in logs).
v1.post('/invitations/inspect', async (c) => c.json(await tenant.inspectInvitation(c.var.auth, await readJson(c))));
v1.post('/invitations/accept', async (c) => c.json(await tenant.acceptInvitation(c.var.auth, await readJson(c))));

// ---------- Brands ----------
v1.get('/brands', async (c) => {
  const clientId = c.req.query('client_id');
  return c.json(await content.listBrands(c.var.auth, clientId ? { client_id: clientId } : {}));
});
v1.post('/brands', async (c) => c.json(await content.saveBrand(c.var.auth, await readJson(c))));
v1.post('/brands/import', async (c) => c.json(await content.importExistingBrands(c.var.auth)));
v1.get('/brands/:clientId/ghl-accounts', async (c) => c.json(await content.loadGhlAccounts(c.var.auth, { client_id: c.req.param('clientId') })));

// ---------- Social connections (n8n runs GHL behind the scenes) ----------
// ?platform= -> { url } for the platform's login popup
v1.get('/brands/:clientId/connect/start', async (c) => c.json(await connections.connectStart(c.var.auth, c.req.param('clientId'), { platform: c.req.query('platform') })));
// ?platform=&account_id= (from the popup's message) -> pages/profiles to pick
v1.get('/brands/:clientId/connect/accounts', async (c) =>
  c.json(await connections.connectAccounts(c.var.auth, c.req.param('clientId'), { platform: c.req.query('platform'), account_id: c.req.query('account_id') })));
// { platform, account_id, accounts: [picked pages, unchanged] } -> { results, accounts }
v1.post('/brands/:clientId/connect/attach', async (c) => c.json(await connections.connectAttach(c.var.auth, c.req.param('clientId'), await readJson(c))));
// { accounts: [{ id, enabled }] } -> the brand's accounts
v1.post('/brands/:clientId/connect/enabled', async (c) => c.json(await connections.setAccountsEnabled(c.var.auth, c.req.param('clientId'), await readJson(c))));
// Re-run n8n's setup after ghl_status "failed"
v1.post('/brands/:clientId/connect/retry', async (c) => c.json(await connections.retrySetup(c.var.auth, c.req.param('clientId'))));

// ---------- Campaigns and publishing ----------
v1.get('/jobs', async (c) => c.json(await content.listJobs(c.var.auth, { client_id: c.req.query('client_id') })));
v1.get('/jobs/:jobId', async (c) => c.json(await content.getJob(c.var.auth, { job_id: c.req.param('jobId') })));
v1.post('/jobs', async (c) => c.json(await content.createJob(c.var.auth, await readJson(c))));
v1.post('/publish', async (c) => c.json(await content.publishPosts(c.var.auth, await readJson(c))));

// ---------- Editing posts ----------
// { mode: "edit" | "regenerate", instruction? }
v1.post('/posts/:postId/revise', async (c) =>
  c.json(await content.revisePost(c.var.auth, { ...obj(await readJson(c)), post_id: c.req.param('postId') }), 202));
// { version_id }
v1.post('/posts/:postId/version', async (c) =>
  c.json(await content.setPostVersion(c.var.auth, { ...obj(await readJson(c)), post_id: c.req.param('postId') })));
