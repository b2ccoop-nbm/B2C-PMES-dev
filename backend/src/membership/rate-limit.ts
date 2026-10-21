export const RATE_DRAFTS_PER_IP_HOUR = 5;
export const RATE_SUBMITS_PER_EMAIL_DAY = 3;
export const RATE_LOOKUPS_PER_IP_HOUR = 30;

export type RateWindow = { bucketKey: string; windowStart: Date; limit: number };

export function hourWindowStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), 0, 0, 0));
}

export function dayWindowStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
}

export function draftIpWindow(ip: string, now = new Date()): RateWindow {
  return { bucketKey: `draft:ip:${ip}`, windowStart: hourWindowStart(now), limit: RATE_DRAFTS_PER_IP_HOUR };
}

export function submitEmailWindow(email: string, now = new Date()): RateWindow {
  return { bucketKey: `submit:email:${email}`, windowStart: dayWindowStart(now), limit: RATE_SUBMITS_PER_EMAIL_DAY };
}

export function lookupIpWindow(ip: string, now = new Date()): RateWindow {
  return { bucketKey: `lookup:ip:${ip}`, windowStart: hourWindowStart(now), limit: RATE_LOOKUPS_PER_IP_HOUR };
}

export function isRateLimited(count: number, limit: number): boolean {
  return count >= limit;
}
