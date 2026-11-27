// Brands, campaigns and publishing through the n8n content API. Same rules as before the
// frontend/backend split: every call checks the user's access to the brand first.
import { z } from 'zod';
import type { AuthContext } from '@/http';
import type { Collections } from '@/lib/db/mongo.server';
import { withTransaction } from '@/lib/db/mongo.server';
import { defaultPlan } from '@/lib/mavera/plans.server';
import { smRequest as sm } from '@/lib/mavera/sm-api.server';
import { REFERENCE_MAX_BYTES, decodedSize, referenceUploadSchema, type ReferenceFile, brandSchema, clientIdSchema, jobIdFromPostId, jobSchema, publishSchema, reviseSchema, validate, versionSchema, type Brand, type GhlAccount, type Job, type Post, type Progress, type PublishResult } from '@/lib/mavera/sm-shared';
import { monthKey } from '@/lib/mavera/tenant-shared';
import { accountForClient, requireAgency, reserveVideos, subAccountAccess, visibleAccounts } from '@/lib/mavera/tenant.server';

const defaultVideoLimit = () => defaultPlan().monthly_video_limit;
const defaultImageLimit = () => defaultPlan().monthly_image_limit;

/** GHL tokens, sub-account and user IDs stay server-side; users never see them. */
function safeBrand(brand: Brand): Brand {
  const { ghl_token: _t, ghl_location_id: _l, ghl_user_id: _u, ...safe } = brand as Brand & Record<string, unknown>;
  return safe as Brand;
}
async function jobForAccount(db: Collections, userId: string, jobId: string) {
  const result = await sm<{ job: Job | null; progress?: Progress; done: boolean; posts: Post[] }>(`sm/job?job_id=${encodeURIComponent(jobId)}`);
  if (!result.job) throw new Error('Campaign not found');
  const account = await accountForClient(db, userId, result.job.client_id);
  return { result, account };
}

export async function listBrands(ctx: AuthContext, input: unknown) {
  const data = validate(z.object({ client_id: clientIdSchema.optional() }))(input ?? {});
  const accounts = (await visibleAccounts(ctx.db, ctx.userId).catch(() => { throw new Error('Could not load sub-accounts'); }))
    .filter((a) => !data.client_id || a.client_id === data.client_id);
  return (await Promise.all(accounts.map(async (a) => {
    const r = await sm<{ brands: Brand[] }>(`sm/brands?client_id=${encodeURIComponent(a.client_id)}`);
    return r.brands.filter((b) => b.client_id === a.client_id).map(safeBrand);
  }))).flat();
}

export async function importExistingBrands(ctx: AuthContext) {
  const { db, userId } = ctx;
  const agency = await requireAgency(db, userId);
  const { brands } = await sm<{ brands: Brand[] }>('sm/brands');
  const videoLimit = defaultVideoLimit();
  try {
    if (brands.length) await db.subAccounts.bulkWrite(brands.map((b) => ({ updateOne: {
      filter: { client_id: b.client_id },
      update: { $setOnInsert: { id: crypto.randomUUID(), agency_id: agency, client_id: b.client_id, name: b.name, timezone: b.timezone || 'Europe/London', monthly_video_limit: videoLimit, monthly_image_limit: defaultImageLimit(), created_at: new Date() } },
      upsert: true,
    } })), { ordered: false });
  } catch (error) {
    console.error('importExistingBrands failed', error);
    throw new Error('Could not assign existing brands');
  }
  for (const account of await visibleAccounts(db, userId)) {
    const { jobs } = await sm<{ jobs: Job[] }>(`sm/jobs?client_id=${encodeURIComponent(account.client_id)}&limit=100`);
    for (const job of jobs.filter((j) => j.client_id === account.client_id)) {
      await db.jobs.updateOne({ job_id: job.job_id }, { $setOnInsert: { job_id: job.job_id, sub_account_id: account.id, created_at: new Date() } }, { upsert: true })
        .catch(() => { throw new Error('Could not assign existing campaign history'); });
      if (await db.reservations.findOne({ job_id: job.job_id })) continue;
      const detail = await sm<{ job: Job | null; done: boolean; posts: Post[] }>(`sm/job?job_id=${encodeURIComponent(job.job_id)}`);
      if (detail.job?.client_id !== account.client_id) throw new Error('Campaign ownership mismatch');
      const requested = job.video_posts ?? detail.posts.filter((p) => p.type === 'video').length;
      const charged = detail.done ? detail.posts.filter((p) => p.type === 'video' && p.status === 'ready').length : requested;
      const imagesCreated = detail.posts.filter((p) => p.type === 'image' && p.status === 'ready').length;
      await db.reservations.insertOne({
        id: crypto.randomUUID(), sub_account_id: account.id, user_id: userId, month_key: monthKey(new Date(job.created_at), account.timezone),
        requested, charged, images: job.image_posts ?? detail.posts.filter((p) => p.type === 'image').length, ...(detail.done ? { images_charged: imagesCreated } : {}),
        job_id: job.job_id, state: detail.done ? 'done' : 'accepted', created_at: new Date(job.created_at),
      }).catch(() => { throw new Error('Could not import video usage history'); });
    }
  }
  return { count: brands.length };
}

export async function saveBrand(ctx: AuthContext, input: unknown) {
  const data = validate(brandSchema)(input);
  const { db, userId } = ctx;
  const existing = await db.subAccounts.findOne({ client_id: data.client_id });
  const visible = !!existing && await subAccountAccess(db, userId, existing);
  let agency: string | undefined;
  if (visible) await accountForClient(db, userId, data.client_id, true);
  else {
    agency = await requireAgency(db, userId);
    const upstream = await sm<{ brands: Brand[] }>(`sm/brands?client_id=${encodeURIComponent(data.client_id)}`);
    if (upstream.brands.length) throw new Error('This Brand ID already exists. Import existing brands or choose another name.');
  }
  if (data.timezone) { try { new Intl.DateTimeFormat('en', { timeZone: data.timezone }).format(); } catch { throw new Error('Choose a valid timezone'); } }
  // n8n assigns the GHL sub-account and user itself a few seconds after saving (ghl_status).
  const saved = (await sm<{ ok: boolean; brand: Brand }>('sm/brands', { method: 'POST', body: data })).brand;
  if (agency) {
    await db.subAccounts.insertOne({ id: crypto.randomUUID(), agency_id: agency, client_id: data.client_id, name: data.name, timezone: data.timezone || 'Europe/London', monthly_video_limit: defaultVideoLimit(), monthly_image_limit: defaultImageLimit(), created_at: new Date() })
      .catch(() => { throw new Error('Brand saved but sub-account assignment needs administrator attention'); });
  } else {
    await db.subAccounts.updateOne({ client_id: data.client_id }, { $set: { name: data.name, ...(data.timezone ? { timezone: data.timezone } : {}) } })
      .catch(() => { throw new Error('Could not update sub-account settings'); });
  }
  return safeBrand(saved);
}

/**
 * Upload one reference file (image or PDF, max 10 MB) for a brand's next content request.
 * Anyone who can create content for the brand may upload; the file goes to the content service's storage.
 */
export async function uploadReference(ctx: AuthContext, clientId: string, input: unknown) {
  const id = validate(clientIdSchema)(clientId);
  const data = validate(referenceUploadSchema)(input);
  await accountForClient(ctx.db, ctx.userId, id);
  const size = decodedSize(data.data);
  if (size < 1) throw new Error('The file is empty');
  if (size > REFERENCE_MAX_BYTES) throw new Error('File is larger than 10 MB');
  const r = await sm<{ ok: boolean; reference?: ReferenceFile }>('sm/reference', {
    method: 'POST', body: { client_id: id, file_name: data.file_name, mime_type: data.mime_type, data: data.data },
  });
  if (!r.reference?.url) throw new Error('Upload to storage failed. Please retry.');
  return r.reference;
}

/** True when a reference URL is one of this brand's uploads (https, under refs/<client_id>/). */
export function referenceBelongsTo(url: string, clientId: string) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.pathname.includes(`/refs/${clientId}/`);
  } catch { return false; }
}

export async function createJob(ctx: AuthContext, input: unknown) {
  const data = validate(jobSchema)(input);
  const { db, userId } = ctx;
  const account = await accountForClient(db, userId, data.client_id);
  // References must be files uploaded for this brand (the content service stores them under refs/<client_id>/).
  if (data.references?.some((r) => !referenceBelongsTo(r.url, data.client_id))) throw new Error('Attach files uploaded for this brand only');
  if (data.references && !data.references.length) delete data.references;
  const reservation = await reserveVideos(db, withTransaction, userId, account.id, data.video_posts, data.image_posts);
  try {
    const result = await sm<{ status: string; job_id: string }>('sm/create-content', { method: 'POST', body: data });
    const tracked = await Promise.all([
      db.jobs.insertOne({ job_id: result.job_id, sub_account_id: account.id, created_at: new Date() }).then(() => true, () => false),
      db.reservations.updateOne({ id: reservation }, { $set: { job_id: result.job_id, state: 'accepted' } }).then(() => true, () => false),
    ]);
    if (tracked.includes(false)) throw new Error('Generation accepted but usage tracking needs administrator attention');
    return result;
  } catch (e) {
    // Uncertain acceptance keeps the reservation counted, so a retry cannot double spend.
    await db.reservations.updateOne({ id: reservation, state: 'reserved' }, { $set: { state: 'uncertain' } });
    throw e;
  }
}

export async function listJobs(ctx: AuthContext, input: unknown) {
  const data = validate(z.object({ client_id: clientIdSchema }))(input);
  await accountForClient(ctx.db, ctx.userId, data.client_id);
  const result = await sm<{ jobs: Job[] }>(`sm/jobs?client_id=${encodeURIComponent(data.client_id)}&limit=100`);
  return (result.jobs ?? []).filter((j) => j.client_id === data.client_id);
}

export async function getJob(ctx: AuthContext, input: unknown) {
  const data = validate(z.object({ job_id: z.string().regex(/^[A-Za-z0-9_-]{3,100}$/) }))(input);
  const { result, account } = await jobForAccount(ctx.db, ctx.userId, data.job_id);
  if (result.done) {
    // Only what was actually created counts: failed videos and images are given back.
    // Campaigns finished before images were given back (no images_charged yet) are corrected too.
    const ready = (type: 'image' | 'video') => result.posts.filter((p) => p.type === type && p.status === 'ready').length;
    await ctx.db.reservations.updateOne(
      { job_id: data.job_id, sub_account_id: account.id, $or: [{ state: { $in: ['accepted', 'uncertain'] } }, { state: 'done', images_charged: { $exists: false } }] },
      { $set: { state: 'done', charged: ready('video'), images_charged: ready('image') } },
    );
  }
  return result;
}

export async function loadGhlAccounts(ctx: AuthContext, input: unknown) {
  const data = validate(z.object({ client_id: clientIdSchema }))(input);
  await accountForClient(ctx.db, ctx.userId, data.client_id, true);
  return (await sm<{ ok: boolean; accounts: GhlAccount[] }>(`sm/ghl-accounts?client_id=${encodeURIComponent(data.client_id)}`)).accounts ?? [];
}

/**
 * Edit (same media with one change) or regenerate a post. Video changes cost real money, so each one
 * uses 1 video from the brand's monthly allowance; image changes are free (like image-only campaigns).
 */
export async function revisePost(ctx: AuthContext, input: unknown) {
  const data = validate(reviseSchema)(input);
  const { result, account } = await jobForAccount(ctx.db, ctx.userId, jobIdFromPostId(data.post_id));
  const post = result.posts.find((p) => p.post_id === data.post_id);
  if (!post) throw new Error('Post not found in this campaign');
  if (post.edit_status === 'editing') throw new Error('This post is already being changed. Please wait until it finishes.');
  if (data.mode === 'edit' && post.status !== 'ready') throw new Error('Only ready posts can be edited. Use Regenerate instead.');
  if (data.mode === 'regenerate' && post.status === 'generating') throw new Error('This post is still being created. Please wait until it finishes.');

  const reservation = post.type === 'video' ? await reserveVideos(ctx.db, withTransaction, ctx.userId, account.id, 1) : null;
  const tag = { kind: 'revise' as const, post_id: data.post_id };
  try {
    const response = await sm<{ ok: boolean; post_id: string; mode: string; status: string }>('sm/post/revise', {
      method: 'POST', body: { post_id: data.post_id, mode: data.mode, ...(data.instruction ? { instruction: data.instruction } : {}) },
    });
    if (reservation) await ctx.db.reservations.updateOne({ id: reservation }, { $set: { ...tag, state: 'done' } });
    return response;
  } catch (error) {
    if (reservation) {
      // A rejected request gives the video back; a timeout may still have been accepted, so it stays counted.
      const uncertain = error instanceof Error && /took too long|Could not reach/.test(error.message);
      await ctx.db.reservations.updateOne({ id: reservation }, { $set: uncertain ? { ...tag, state: 'uncertain' } : { ...tag, state: 'released', charged: 0 } });
    }
    throw error;
  }
}

/** Switch a post to an earlier version; publishing uses the selected one. */
export async function setPostVersion(ctx: AuthContext, input: unknown) {
  const data = validate(versionSchema)(input);
  const { result } = await jobForAccount(ctx.db, ctx.userId, jobIdFromPostId(data.post_id));
  const post = result.posts.find((p) => p.post_id === data.post_id);
  if (!post) throw new Error('Post not found in this campaign');
  if (post.edit_status === 'editing') throw new Error('Please wait until the current change finishes.');
  if (post.versions && !post.versions.some((v) => v.version_id === data.version_id)) throw new Error('That version is no longer available.');
  try {
    return await sm<{ ok: boolean }>('sm/post/version', { method: 'POST', body: { post_id: data.post_id, version_id: data.version_id } });
  } catch (error) {
    if (error instanceof Error && /\b404\b|not found/i.test(error.message)) throw new Error('That version is no longer available.');
    throw error;
  }
}

export async function publishPosts(ctx: AuthContext, input: unknown) {
  const data = validate(publishSchema)(input);
  if (!data.job_id) throw new Error('Campaign ID required');
  const { result, account } = await jobForAccount(ctx.db, ctx.userId, data.job_id);
  if (data.post_ids?.some((postId) => !result.posts.some((p) => p.post_id === postId))) throw new Error('Post does not belong to this campaign');
  const body = data.post_ids ? { ...data, job_id: undefined } : data;
  return sm<PublishResult>('sm/publish', { method: 'POST', body });
}
