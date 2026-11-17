import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '@/http';
import type { Collections } from '@/lib/db/mongo.server';

// Fake content API and transactions: no network or database.
const { sm } = vi.hoisted(() => ({ sm: vi.fn() }));
vi.mock('@/lib/mavera/sm-api.server', () => ({ smRequest: sm }));
vi.mock('@/lib/db/mongo.server', () => ({ withTransaction: <T>(fn: (s: never) => Promise<T>) => fn(undefined as never) }));
const { revisePost, setPostVersion, uploadReference, createJob, referenceBelongsTo } = await import('./content');

type Doc = Record<string, any>;
const matches = (doc: Doc, filter: Doc) => Object.entries(filter).every(([k, v]) =>
  v === null ? doc[k] === null || doc[k] === undefined : v && typeof v === 'object' && '$in' in v ? (v['$in'] as unknown[]).includes(doc[k]) : doc[k] === v);
function collection(rows: Doc[] = []) {
  const apply = (d: Doc, u: Doc) => { Object.assign(d, u['$set'] ?? {}); for (const [k, v] of Object.entries(u['$inc'] ?? {})) d[k] = (d[k] ?? 0) + (v as number); };
  return {
    rows,
    findOne: async (f: Doc) => rows.find((r) => matches(r, f)) ?? null,
    find: (f: Doc) => ({ toArray: async () => rows.filter((r) => matches(r, f)) }),
    findOneAndUpdate: async (f: Doc, u: Doc) => { const d = rows.find((r) => matches(r, f)); if (d) apply(d, u); return d ?? null; },
    insertOne: async (d: Doc) => { rows.push(d); },
    updateOne: async (f: Doc, u: Doc) => { const d = rows.find((r) => matches(r, f)); if (d) apply(d, u); },
  };
}
const account = { id: 'acc-1', agency_id: 'agency', client_id: 'acme', name: 'Acme', timezone: 'Europe/London', monthly_video_limit: 2, created_at: new Date() };
function ctx(memberOf = 'acc-1') {
  const db = {
    subAccounts: collection([{ ...account }]), agencyMemberships: collection(), reservations: collection(), jobs: collection(),
    subAccountMemberships: collection([{ sub_account_id: memberOf, user_id: 'me', role: 'member', revoked_at: null }]),
  } as unknown as Collections & { [K in keyof Collections]: Collections[K] & { rows: Doc[] } };
  return { db, userId: 'me', user: { id: 'me', email: 'me@example.com', emailVerified: true } } as AuthContext & { db: typeof db };
}
const job = (posts: Doc[]) => ({ job: { job_id: 'job_1_abc', client_id: 'acme' }, done: true, posts });
const video = { post_id: 'job_1_abc_p01', type: 'video', status: 'ready' };
const image = { post_id: 'job_1_abc_p02', type: 'image', status: 'ready' };

beforeEach(() => { sm.mockReset(); });

describe('editing and regenerating posts', () => {
  it('sends the change and uses 1 video from the allowance for a video', async () => {
    const c = ctx();
    sm.mockImplementation(async (path: string) => (path.startsWith('sm/job?') ? job([video]) : { ok: true, status: 'editing' }));
    await expect(revisePost(c, { post_id: video.post_id, mode: 'edit', instruction: 'Make her jacket red' })).resolves.toMatchObject({ status: 'editing' });
    expect(sm).toHaveBeenLastCalledWith('sm/post/revise', { method: 'POST', body: { post_id: video.post_id, mode: 'edit', instruction: 'Make her jacket red' } });
    expect(c.db.reservations.rows).toEqual([expect.objectContaining({ charged: 1, state: 'done', kind: 'revise', post_id: video.post_id })]);
  });
  it('keeps image changes free', async () => {
    const c = ctx();
    sm.mockImplementation(async (path: string) => (path.startsWith('sm/job?') ? job([image]) : { ok: true }));
    await revisePost(c, { post_id: image.post_id, mode: 'regenerate' });
    expect(c.db.reservations.rows).toEqual([]);
  });
  it('gives the video back when the content service rejects the change', async () => {
    const c = ctx();
    sm.mockImplementation(async (path: string) => { if (path.startsWith('sm/job?')) return job([video]); throw new Error('This post is already being edited'); });
    await expect(revisePost(c, { post_id: video.post_id, mode: 'edit', instruction: 'Brighter' })).rejects.toThrow('already being edited');
    expect(c.db.reservations.rows[0]).toMatchObject({ state: 'released', charged: 0 });
  });
  it('stops when the monthly video allowance is used up', async () => {
    const c = ctx();
    const month = new Intl.DateTimeFormat('en', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
    const key = `${month.find((p) => p.type === 'year')?.value}-${month.find((p) => p.type === 'month')?.value}`;
    c.db.reservations.rows.push({ id: 'r', sub_account_id: 'acc-1', month_key: key, charged: 2 });
    sm.mockImplementation(async () => job([video]));
    await expect(revisePost(c, { post_id: video.post_id, mode: 'regenerate' })).rejects.toThrow('Monthly video allowance exceeded');
  });
  it('refuses to edit a post that is not ready, and needs a description for edits', async () => {
    const c = ctx();
    sm.mockImplementation(async () => job([{ ...video, status: 'failed' }]));
    await expect(revisePost(c, { post_id: video.post_id, mode: 'edit', instruction: 'x' })).rejects.toThrow('Only ready posts can be edited');
    await expect(revisePost(c, { post_id: video.post_id, mode: 'edit' })).rejects.toThrow('Describe the change you want');
  });
  it('blocks users without access to the brand', async () => {
    const c = ctx('another-account');
    sm.mockImplementation(async () => job([video]));
    await expect(revisePost(c, { post_id: video.post_id, mode: 'regenerate' })).rejects.toThrow('access denied');
    expect(sm).toHaveBeenCalledTimes(1);
  });
});

describe('switching versions', () => {
  it('switches to an existing version and rejects unknown ones', async () => {
    const c = ctx();
    const withVersions = { ...video, versions: [{ version_id: 101, version: 1, source: 'original', instruction: null }] };
    sm.mockImplementation(async (path: string) => (path.startsWith('sm/job?') ? job([withVersions]) : { ok: true }));
    await expect(setPostVersion(c, { post_id: video.post_id, version_id: 101 })).resolves.toEqual({ ok: true });
    await expect(setPostVersion(c, { post_id: video.post_id, version_id: 999 })).rejects.toThrow('no longer available');
  });
});

describe('reference uploads', () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  it('uploads a file for a brand the user can access and returns the stored reference', async () => {
    sm.mockResolvedValue({ ok: true, reference: { url: 'https://x.supabase.co/storage/v1/object/public/sm-media/refs/acme/1_a.png', mime_type: 'image/png', name: 'a.png', size: 72 } });
    await expect(uploadReference(ctx(), 'acme', { file_name: 'a.png', mime_type: 'image/png', data: png })).resolves.toMatchObject({ name: 'a.png' });
    expect(sm).toHaveBeenCalledWith('sm/reference', { method: 'POST', body: { client_id: 'acme', file_name: 'a.png', mime_type: 'image/png', data: png } });
  });
  it('refuses other file types, files over 10 MB and brands the user cannot access', async () => {
    await expect(uploadReference(ctx(), 'acme', { file_name: 'a.gif', mime_type: 'image/gif', data: png })).rejects.toThrow(/PNG, JPEG, WEBP or PDF/);
    const big = 'A'.repeat(Math.ceil((10 * 1024 * 1024 + 10) / 3) * 4);
    await expect(uploadReference(ctx(), 'acme', { file_name: 'big.png', mime_type: 'image/png', data: big })).rejects.toThrow('File is larger than 10 MB');
    await expect(uploadReference(ctx('another-account'), 'acme', { file_name: 'a.png', mime_type: 'image/png', data: png })).rejects.toThrow(/access denied/i);
    expect(sm).not.toHaveBeenCalled();
  });
  it('only accepts references uploaded for the same brand', async () => {
    expect(referenceBelongsTo('https://x.supabase.co/storage/v1/object/public/sm-media/refs/acme/1_a.png', 'acme')).toBe(true);
    expect(referenceBelongsTo('https://x.supabase.co/storage/v1/object/public/sm-media/refs/other-brand/1_a.png', 'acme')).toBe(false);
    expect(referenceBelongsTo('http://x.example/refs/acme/a.png', 'acme')).toBe(false);
    const input = { client_id: 'acme', prompt: 'Coffee in our shop', image_posts: 1, video_posts: 0, references: [{ url: 'https://evil.example/refs/other/a.png', mime_type: 'image/png', name: 'a.png' }] };
    await expect(createJob(ctx(), input)).rejects.toThrow('Attach files uploaded for this brand only');
    expect(sm).not.toHaveBeenCalled();
  });
  it('sends references with the content request', async () => {
    sm.mockResolvedValue({ status: 'planning', job_id: 'job_9_new' });
    const ref = { url: 'https://x.supabase.co/storage/v1/object/public/sm-media/refs/acme/1_menu.pdf', mime_type: 'application/pdf', name: 'menu.pdf', note: 'our menu' };
    await createJob(ctx(), { client_id: 'acme', prompt: 'Coffee in our shop', image_posts: 1, video_posts: 0, references: [ref] });
    expect(sm).toHaveBeenCalledWith('sm/create-content', { method: 'POST', body: expect.objectContaining({ references: [ref] }) });
  });
});
