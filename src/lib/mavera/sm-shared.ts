import { z } from "zod";

export const SM_PLATFORMS = [
  "instagram", "facebook", "tiktok", "linkedin", "x", "youtube", "google_business", "threads", "pinterest",
] as const;
export const SM_RATIOS = ["1:1", "4:5", "9:16", "16:9"] as const;

/** Settings every new brand starts with, whether created in the brand form or through the provisioning API. */
export const NEW_BRAND_DEFAULTS = {
  platforms: ["instagram", "facebook"] as (typeof SM_PLATFORMS)[number][],
  language: "British English",
  timezone: "Europe/London",
  image_aspect_ratio: "4:5" as (typeof SM_RATIOS)[number],
  video_finish: true, subtitles: true, music_volume: "15%",
};

/** Content languages offered in the brand form (sent to the AI as written). */
export const BRAND_LANGUAGES = [
  "British English", "American English", "Australian English", "Canadian English", "Irish English",
  "Arabic", "Bengali", "Chinese (Simplified)", "Chinese (Traditional)", "Danish", "Dutch", "Finnish",
  "French", "German", "Greek", "Hebrew", "Hindi", "Indonesian", "Italian", "Japanese", "Korean", "Malay",
  "Norwegian", "Polish", "Portuguese (Brazil)", "Portuguese (Portugal)", "Punjabi", "Romanian", "Russian",
  "Spanish (Latin America)", "Spanish (Spain)", "Swedish", "Tagalog", "Thai", "Turkish", "Ukrainian", "Urdu",
  "Vietnamese", "Welsh",
] as const;

const FALLBACK_TIMEZONES = [
  "Europe/London", "Europe/Dublin", "Europe/Paris", "Europe/Berlin", "Europe/Madrid", "Europe/Rome", "Europe/Amsterdam",
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Toronto",
  "Asia/Dubai", "Asia/Karachi", "Asia/Kolkata", "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney", "Pacific/Auckland", "UTC",
];

/** Every timezone the browser knows, as { value, label } with the current UTC offset, e.g. "Europe/London (GMT+0)". */
export function timezoneOptions(now = new Date()): { value: string; label: string }[] {
  let zones: string[];
  try {
    zones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? FALLBACK_TIMEZONES;
  } catch { zones = FALLBACK_TIMEZONES; }
  if (!zones.includes("UTC")) zones = [...zones, "UTC"];
  return zones.map((zone) => {
    let offset = "";
    try {
      offset = new Intl.DateTimeFormat("en-GB", { timeZone: zone, timeZoneName: "shortOffset" }).formatToParts(now).find((p) => p.type === "timeZoneName")?.value ?? "";
    } catch { /* unknown zone */ }
    return { value: zone, label: `${zone.replace(/_/g, " ")}${offset ? ` (${offset === "GMT" ? "GMT+0" : offset})` : ""}` };
  });
}

export function slugify(name: string) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
}

export const clientIdSchema = z.string().regex(/^[a-z0-9-]{2,50}$/, "Brand ID must be 2–50 lowercase letters, numbers or dashes");

/** Brand field limits, shared by the form (counters, maxLength) and server validation. */
export const BRAND_LIMITS = {
  name: 120, description: 1000, audience: 500, tone: 300, colours: 300, website: 300, rules: 1000,
  language: 60, timezone: 60, ghl_location_id: 100, ghl_token: 500, ghl_user_id: 100,
  logo_url: 500, music_url: 500,
} as const;
/** Field names as users see them in the forms. */
export const FIELD_LABELS: Record<string, string> = {
  client_id: "Brand ID", name: "Brand name", description: "Description", audience: "Audience", tone: "Tone of voice",
  colours: "Brand colours", website: "Website", rules: "Rules (things to avoid)", platforms: "Platforms", language: "Language",
  timezone: "Timezone", image_aspect_ratio: "Image shape", ghl_location_id: "Location ID", ghl_token: "Private integration token",
  ghl_user_id: "User ID", ghl_accounts: "Connected social accounts", prompt: "Campaign brief", image_posts: "Images",
  video_posts: "Videos", start_date: "Plan posts from", video_seconds: "Video length", schedule_at: "Post at",
  post_ids: "Posts", job_id: "Campaign", email: "Email", limit: "Monthly video allowance", role: "Role",
  token: "Invitation link", logo_url: "Logo URL", music_url: "Music URL", music_volume: "Music volume",
  subtitles: "Subtitles", video_finish: "Video finishing",
};
const n = (value: number) => value.toLocaleString("en-GB");
const limited = (field: keyof typeof BRAND_LIMITS) =>
  z.string({ error: `${FIELD_LABELS[field]} must be text` }).max(BRAND_LIMITS[field], `${FIELD_LABELS[field]} must be ${n(BRAND_LIMITS[field])} characters or fewer`);

/** One readable sentence per problem, naming the field, instead of zod's raw JSON. */
export function readableIssues(error: z.ZodError): string {
  return error.issues.map((issue) => {
    const key = issue.path.find((p): p is string => typeof p === "string") ?? "";
    const field = FIELD_LABELS[key];
    // Custom messages already name the field; generic ones get the field name in front.
    return field && !issue.message.startsWith(field) ? `${field}: ${issue.message}` : issue.message;
  }).join(" ");
}
/** Server function input validator that throws a readable error. */
export function validate<S extends z.ZodType>(schema: S) {
  return (data: unknown): z.infer<S> => {
    const result = schema.safeParse(data);
    if (!result.success) throw new Error(readableIssues(result.error));
    return result.data;
  };
}

/** A public http(s) link the content service can download, or "" to remove it. */
const publicUrl = (field: "logo_url" | "music_url") =>
  z.union([
    z.literal(""),
    z.string({ error: `${FIELD_LABELS[field]} must be text` }).trim().max(BRAND_LIMITS[field], `${FIELD_LABELS[field]} must be ${n(BRAND_LIMITS[field])} characters or fewer`)
      .regex(/^https?:\/\/\S+$/i, `${FIELD_LABELS[field]} must be a public link starting with https://`),
  ]);

/** Defaults the content service uses when a brand has no finishing settings. */
export const VIDEO_FINISH_DEFAULTS = { music_volume: "15%", subtitles: true, video_finish: true } as const;

export const brandSchema = z.object({
  client_id: clientIdSchema,
  name: limited("name").trim().min(1, "Brand name is required"),
  description: limited("description").optional(),
  audience: limited("audience").optional(),
  tone: limited("tone").optional(),
  colours: limited("colours").optional(),
  website: limited("website").optional(),
  rules: limited("rules").optional(),
  platforms: z.array(z.enum(SM_PLATFORMS)).max(9).optional(),
  language: limited("language").optional(),
  timezone: limited("timezone").optional(),
  image_aspect_ratio: z.enum(SM_RATIOS, { error: "Choose a valid image shape" }).optional(),
  ghl_location_id: limited("ghl_location_id").trim().optional(),
  ghl_token: limited("ghl_token").trim().optional(),
  ghl_user_id: limited("ghl_user_id").trim().optional(),
  ghl_accounts: z.array(z.object({ id: z.string().max(200), platform: z.string().max(50), name: z.string().max(200).optional(), isExpired: z.boolean().optional(), enabled: z.boolean().optional() }).passthrough()).max(50).optional(),
  // Video finishing (applied by the content service before a video is ready). Empty URLs mean "none".
  logo_url: publicUrl("logo_url").nullish(),
  music_url: publicUrl("music_url").nullish(),
  music_volume: z.string({ error: "Music volume must be text" }).regex(/^(100|[1-9]?\d)%$/, "Music volume must be a percentage from 0% to 100%, e.g. 15%").nullish(),
  subtitles: z.boolean({ error: "Subtitles must be on or off" }).nullish(),
  video_finish: z.boolean({ error: "Video finishing must be on or off" }).nullish(),
});
export type GhlAccount = { id: string; platform: string; name?: string; isExpired?: boolean; enabled?: boolean };

/** GHL uses its own names for two platforms. */
const GHL_PLATFORM_ALIASES: Record<string, string> = { twitter: "x", google: "google_business" };
export const toAppPlatform = (platform: string) => GHL_PLATFORM_ALIASES[platform] ?? platform;

/** Which accounts will actually be posted to: ticked and not expired. */
export function connectionStatus(accounts?: GhlAccount[] | null) {
  // The content API sends null for brands without connected accounts.
  accounts = accounts ?? [];
  const active = accounts.filter((a) => a.enabled && !a.isExpired);
  const expired = accounts.filter((a) => a.enabled && a.isExpired);
  return { active, expired, platforms: [...new Set(active.map((a) => toAppPlatform(a.platform)))] };
}

/** Where a post will go when scheduled, and why any of its platforms will be skipped (rules from the content API guide). */
export function postTargets(post: { type: "image" | "video"; platforms?: string[] | undefined }, connected: string[], only: string[] = []) {
  const go: string[] = [];
  const skip: { platform: string; reason: string }[] = [];
  for (const raw of post.platforms ?? []) {
    const p = toAppPlatform(raw);
    if (only.length && !only.includes(p)) continue; // left out on purpose by the platform filter
    if (p === "pinterest") skip.push({ platform: p, reason: "not supported for posting yet" });
    else if (p === "youtube" && post.type === "image") skip.push({ platform: p, reason: "YouTube only takes videos" });
    else if (p === "google_business" && post.type === "video") skip.push({ platform: p, reason: "Google Business only takes images" });
    else if (!connected.includes(p)) skip.push({ platform: p, reason: "not connected" });
    else go.push(p);
  }
  return { go, skip };
}
export type Brand = Omit<z.infer<typeof brandSchema>, "ghl_accounts"> & { created_at?: string; updated_at?: string; has_ghl_token?: boolean; ghl_accounts?: GhlAccount[] };

/** Platforms the publish endpoint can be limited to (Pinterest isn't supported for publishing yet). */
export const PUBLISH_PLATFORMS = ["instagram", "facebook", "tiktok", "linkedin", "youtube", "x", "google_business", "threads"] as const;

export const publishSchema = z.object({
  post_ids: z.array(z.string().regex(/^[A-Za-z0-9_-]{3,120}$/)).min(1).max(50).optional(),
  job_id: z.string().regex(/^[A-Za-z0-9_-]{3,100}$/).optional(),
  mode: z.enum(["schedule", "draft"]).optional(),
  // ISO 8601 with a time zone, e.g. 2026-11-20T09:00:00+00:00 or ...Z
  schedule_at: z.string().max(40).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/, "Choose a valid date and time").optional(),
  platforms: z.array(z.enum(PUBLISH_PLATFORMS)).min(1).max(8).optional(),
}).refine((d) => !!d.post_ids || !!d.job_id, "Choose posts or a job to publish");
/** Post ids look like "<job_id>_p<NN>", so the campaign a post belongs to can be found from its id. */
export const postIdSchema = z.string().regex(/^[A-Za-z0-9_-]{3,120}$/, "Invalid post");
export const jobIdFromPostId = (postId: string) => postId.replace(/_p\d+$/, "");

/** Edit (same image or video with one change) or regenerate (fresh version from the original idea). */
export const reviseSchema = z.object({
  post_id: postIdSchema,
  mode: z.enum(["edit", "regenerate"], { error: "Choose edit or regenerate" }),
  instruction: z.string().trim().max(1000, "Change description must be 1,000 characters or fewer").optional(),
}).refine((d) => d.mode !== "edit" || !!d.instruction, { message: "Describe the change you want", path: ["instruction"] });

/** Switch a post back to an earlier version (the one publishing will use). */
export const versionSchema = z.object({ post_id: postIdSchema, version_id: z.number({ error: "Choose a version" }).int().positive() });

export type GhlPostRef = { platform: string; account_id: string; ghl_post_id: string };
export type PublishResult = {
  ok: boolean; mode?: string; errors?: string[];
  posts?: { post_id: string; publish_status: string; publish_error: string | null; ghl_post_ids?: GhlPostRef[] }[];
};

export const PLATFORM_LABELS: Record<string, string> = {
  instagram: "Instagram", facebook: "Facebook", tiktok: "TikTok", linkedin: "LinkedIn", x: "X",
  youtube: "YouTube", google_business: "Google Business", threads: "Threads", pinterest: "Pinterest",
  // GHL's own names for the same platforms
  twitter: "X", google: "Google Business",
};
export const label = (p: string) => PLATFORM_LABELS[p] ?? p;

export const jobSchema = z
  .object({
    client_id: clientIdSchema,
    prompt: z.string().trim().min(3, "Campaign brief must be at least 3 characters").max(10000, "Campaign brief must be 10,000 characters or fewer"),
    image_posts: z.number().int().min(0).max(10, "Images must be 10 or fewer"),
    video_posts: z.number().int().min(0).max(5, "Videos must be 5 or fewer"),
    platforms: z.array(z.enum(SM_PLATFORMS)).optional(),
    start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    image_aspect_ratio: z.enum(SM_RATIOS).optional(),
    // 8 (default) or 30: 30 makes ~30–40 second videos (8–12 minutes, about $3.80 each).
    video_seconds: z.union([z.literal(8), z.literal(30)]).optional(),
  })
  .refine((j) => j.image_posts + j.video_posts >= 1, "Request at least one image or video");

/** Maximum length of a campaign brief. */
export const PROMPT_MAX = 10000;

export type Progress = { total: number; ready: number; failed: number; generating: number; editing?: number };
export type Job = {
  job_id: string; client_id: string; status: "planning" | "generating" | "done" | "failed";
  prompt: string; image_posts?: number; video_posts?: number; created_at: string; progress?: Progress;
  error?: string | null;
};

/** Plain-English reason for a failed campaign or post, from the raw upstream error. */
export function friendlyJobError(error?: string | null): string {
  if (!error) return "Something went wrong while creating this campaign. Please try again.";
  if (/\b402\b|RESOURCE_EXHAUSTED|credits are depleted|billing|quota/i.test(error)) {
    return "The AI service has run out of credits, so nothing could be generated. Ask your administrator to top up the AI account, then try again.";
  }
  if (/\b429\b|rate limit|too many requests/i.test(error)) return "The AI service is busy right now. Please try again in a few minutes.";
  if (/safety|blocked|policy/i.test(error)) return "The AI service declined this brief. Try rewording it and generate again.";
  const text = error.replace(/\s+/g, " ").trim();
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}
export type Post = {
  post_id: string; type: "image" | "video"; status: "generating" | "ready" | "failed";
  title?: string; caption?: string; hashtags?: string[]; platforms?: string[]; scheduled_for?: string;
  media?: { kind: "image" | "video" | "thumbnail"; url: string; mime_type?: string; seconds?: number }[]; error?: string | null;
  stage?: string | null;
  publish_status?: "scheduled" | "draft" | "partial" | "failed" | null; publish_error?: string | null;
  ghl_post_ids?: GhlPostRef[] | null; publish_requested_at?: string | null;
  /** "editing" while a change runs, "failed" when it didn't work (edit_error says why), null when idle. */
  edit_status?: "editing" | "failed" | null; edit_error?: string | null;
  /** Every result is kept; publishing uses current_version. */
  versions?: PostVersion[] | null; current_version?: number | null;
};
export type PostVersion = {
  version_id: number; version: number; source: string; instruction: string | null;
  media?: Post["media"]; created_at?: string;
};
