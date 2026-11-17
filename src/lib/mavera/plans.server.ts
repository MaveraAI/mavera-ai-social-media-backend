// The single source of truth for what a new sub-account gets. Every creation
// path (brand form, "Import existing brands", the provisioning API) uses this,
// so all new accounts receive exactly the same plan and allowances.
//
// Configure without code changes:
//   DEFAULT_PLAN_NAME              (default: "default")
//   DEFAULT_MONTHLY_VIDEO_LIMIT    (default: 10)
//   DEFAULT_MONTHLY_IMAGE_LIMIT    (default: 30)
// Agency admins can change each brand's allowances afterwards.
import { DEFAULT_MONTHLY_LIMITS } from '@/lib/mavera/tenant-shared';

export type Plan = { name: string; monthly_video_limit: number; monthly_image_limit: number };

function limitFrom(env: Record<string, string | undefined>, key: string, fallback: number) {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100_000) {
    console.error(`[plans] ${key} must be a whole number from 0 to 100000; using ${fallback}.`);
    return fallback;
  }
  return parsed;
}

export function defaultPlan(env: Record<string, string | undefined> = process.env): Plan {
  return {
    name: env['DEFAULT_PLAN_NAME']?.trim() || 'default',
    monthly_video_limit: limitFrom(env, 'DEFAULT_MONTHLY_VIDEO_LIMIT', DEFAULT_MONTHLY_LIMITS.videos),
    monthly_image_limit: limitFrom(env, 'DEFAULT_MONTHLY_IMAGE_LIMIT', DEFAULT_MONTHLY_LIMITS.images),
  };
}
