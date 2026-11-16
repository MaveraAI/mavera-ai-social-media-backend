export type SubAccount = { id: string; agency_id: string; client_id: string; name: string; timezone: string; monthly_video_limit: number };
export type AccessRole = 'admin' | 'member';
export function canManage(role: AccessRole) { return role === 'admin'; }
export function monthKey(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en', { timeZone: timezone, year: 'numeric', month: '2-digit' }).formatToParts(date);
  return `${parts.find(p => p.type === 'year')?.value}-${parts.find(p => p.type === 'month')?.value}`;
}
export function remainingVideos(limit: number, charged: number) { return Math.max(0, limit - charged); }
export function belongsToClient(expected: string, actual: string) { return expected === actual; }