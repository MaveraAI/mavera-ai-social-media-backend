export type SubAccount = { id: string; agency_id: string; client_id: string; name: string; timezone: string; monthly_video_limit: number; monthly_image_limit: number };
/** Allowances every brand gets unless the agency changes them. */
export const DEFAULT_MONTHLY_LIMITS = { videos: 10, images: 30 } as const;
export type AccessRole = 'admin' | 'member';
export function canManage(role: AccessRole) { return role === 'admin'; }
export function monthKey(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en', { timeZone: timezone, year: 'numeric', month: '2-digit' }).formatToParts(date);
  return `${parts.find(p => p.type === 'year')?.value}-${parts.find(p => p.type === 'month')?.value}`;
}
export function remainingVideos(limit: number, charged: number) { return Math.max(0, limit - charged); }
export const remaining = (limit: number, used: number) => Math.max(0, limit - used);
/** Usage for one month: videos and images each have their own allowance. */
export type MonthlyUsage = { month: string; limit: number; used: number; remaining: number; images: { limit: number; used: number; remaining: number } };
export function belongsToClient(expected: string, actual: string) { return expected === actual; }