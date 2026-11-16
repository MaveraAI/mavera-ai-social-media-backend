// The single source of truth for what a new sub-account gets. Every creation
// path (brand form, "Import existing brands", the provisioning API) uses this,
// so all new accounts receive exactly the same plan and allowances.
//
// Configure without code changes:
//   DEFAULT_PLAN_NAME              (default: "default")
//   DEFAULT_MONTHLY_VIDEO_LIMIT    (default: 0, the app's behaviour before this setting existed)
// Image generation has no monthly limit in this app.
export type Plan = { name: string; monthly_video_limit: number };

export function defaultPlan(env: Record<string, string | undefined> = process.env): Plan {
  const raw = env['DEFAULT_MONTHLY_VIDEO_LIMIT'];
  const parsed = raw === undefined || raw.trim() === '' ? 0 : Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100_000) {
    console.error('[plans] DEFAULT_MONTHLY_VIDEO_LIMIT must be a whole number from 0 to 100000; using 0.');
    return { name: env['DEFAULT_PLAN_NAME']?.trim() || 'default', monthly_video_limit: 0 };
  }
  return { name: env['DEFAULT_PLAN_NAME']?.trim() || 'default', monthly_video_limit: parsed };
}
