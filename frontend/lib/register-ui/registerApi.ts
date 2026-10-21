export type RegisterApplication = {
  id: string;
  status: string;
  fullName: string | null;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  dob: string | null;
  gender: string | null;
  email: string;
  mobile: string | null;
  tinNo: string | null;
  residentialAddress: {
    street?: string;
    barangay?: string;
    cityMunicipality?: string;
    province?: string;
    zip?: string;
  } | null;
  referredByParticipantId: string | null;
  shareCapitalAmount: number;
  shareCapitalPaid: boolean;
  membershipFeePaid: boolean;
  paymentMode: "CASH" | "GCASH" | null;
  gcashRefNo: string | null;
  hasGcashScreenshot: boolean;
  dpaConsentAt: string | null;
  resumeToken?: string;
  memberIdNo?: string;
};

function apiBase(): string {
  if (typeof window === "undefined") return "";
  const fromEnv =
    (typeof import.meta !== "undefined" &&
      (import.meta as { env?: { VITE_API_BASE_URL?: string } }).env?.VITE_API_BASE_URL) ||
    "";
  return String(fromEnv || "").replace(/\/$/, "");
}

function storageTokenKey(id: string) {
  return `b2c_membership_resume_${id}`;
}

export function rememberResume(id: string, token: string) {
  try {
    localStorage.setItem(storageTokenKey(id), token);
    localStorage.setItem("b2c_membership_application_id", id);
  } catch {
    /* ignore */
  }
}

export function readResume(id?: string | null): { id: string | null; token: string | null } {
  try {
    const appId = id || localStorage.getItem("b2c_membership_application_id");
    const token = appId ? localStorage.getItem(storageTokenKey(appId)) : null;
    return { id: appId, token };
  } catch {
    return { id: null, token: null };
  }
}

async function parseError(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const j = JSON.parse(text) as { message?: string };
    return j.message || text || `Request failed (${res.status})`;
  } catch {
    return text || `Request failed (${res.status})`;
  }
}

async function req(path: string, init: RequestInit & { resumeToken?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type") && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  if (init.resumeToken) headers.set("X-Resume-Token", init.resumeToken);
  const res = await fetch(`${apiBase()}${path}`, { ...init, headers });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function createApplication(input: {
  email: string;
  mobile: string;
  dpaConsent: boolean;
  captchaToken?: string;
  referralCode?: string;
}): Promise<RegisterApplication> {
  const body = await req("/membership/applications", { method: "POST", body: JSON.stringify(input) });
  if (body.resumeToken) rememberResume(body.id, body.resumeToken);
  return body;
}

export async function loadApplication(id: string, token: string): Promise<RegisterApplication> {
  return req(`/membership/applications/${encodeURIComponent(id)}`, { resumeToken: token });
}

export async function resumeByToken(token: string): Promise<RegisterApplication> {
  const body = await req(`/membership/resume?t=${encodeURIComponent(token)}`);
  if (body.id && body.resumeToken) rememberResume(body.id, body.resumeToken);
  return body;
}

export async function patchApplication(id: string, token: string, fields: Record<string, unknown>) {
  return req(`/membership/applications/${encodeURIComponent(id)}`, {
    method: "PATCH",
    resumeToken: token,
    body: JSON.stringify(fields),
  }) as Promise<{ application: RegisterApplication; warnings?: { field: string; message: string }[] }>;
}

export async function submitApplication(id: string, token: string, captchaToken?: string) {
  const body = await req(`/membership/applications/${encodeURIComponent(id)}/submit`, {
    method: "POST",
    resumeToken: token,
    body: JSON.stringify({ captchaToken }),
  });
  if (body.resumeToken) rememberResume(id, body.resumeToken);
  return body as RegisterApplication & { memberIdNo: string; needsTin: boolean };
}

export async function lookupReferrer(q: string) {
  return req(`/membership/referrer-lookup?q=${encodeURIComponent(q)}`) as Promise<{
    results: { memberIdNo: string; displayName: string; participantId: string }[];
  }>;
}

export async function uploadScreenshot(id: string, token: string, file: File) {
  const form = new FormData();
  form.set("file", file);
  form.set("resumeToken", token);
  const res = await fetch(`${apiBase()}/membership/applications/${encodeURIComponent(id)}/gcash-screenshot`, {
    method: "POST",
    headers: { "X-Resume-Token": token },
    body: form,
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export function enqueueOfflinePatch(id: string, fields: Record<string, unknown>) {
  try {
    const key = `b2c_membership_offline_${id}`;
    const prev = JSON.parse(localStorage.getItem(key) || "[]") as Record<string, unknown>[];
    prev.push(fields);
    localStorage.setItem(key, JSON.stringify(prev));
  } catch {
    /* ignore */
  }
}

export async function flushOfflineQueue(id: string, token: string) {
  const key = `b2c_membership_offline_${id}`;
  let queued: Record<string, unknown>[] = [];
  try {
    queued = JSON.parse(localStorage.getItem(key) || "[]") as Record<string, unknown>[];
  } catch {
    queued = [];
  }
  if (!queued.length) return;
  for (const fields of queued) {
    await patchApplication(id, token, fields);
  }
  localStorage.removeItem(key);
}
