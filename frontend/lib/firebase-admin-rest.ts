import { importPKCS8, SignJWT } from "jose";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const IDENTITY_TOOLKIT = "https://identitytoolkit.googleapis.com/v1";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function hasFirebaseServiceAccountConfig(): boolean {
  return Boolean(process.env.FIREBASE_CLIENT_EMAIL?.trim() && process.env.FIREBASE_PRIVATE_KEY?.trim());
}

export const FIREBASE_ADMIN_MISSING_MSG =
  "Firebase Admin is not configured on the API (set FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY as Worker secrets). Email/password changes for linked members cannot run until then.";

async function getAccessTokenFromServiceAccount(): Promise<string> {
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim();
  let privateKey = process.env.FIREBASE_PRIVATE_KEY?.trim();
  if (!clientEmail || !privateKey) {
    throw new Error(FIREBASE_ADMIN_MISSING_MSG);
  }
  privateKey = privateKey.replace(/\\n/g, "\n");
  const key = await importPKCS8(privateKey, "RS256");
  const jwt = await new SignJWT({
    scope:
      "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/identitytoolkit",
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(clientEmail)
    .setSubject(clientEmail)
    .setAudience(TOKEN_URL)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key);

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const json = (await res.json()) as { access_token?: string; error_description?: string; error?: string };
  if (!res.ok || !json.access_token) {
    const desc = json.error_description || json.error || `OAuth failed (${res.status})`;
    if (/account not found/i.test(desc)) {
      throw new Error(
        "Firebase service account is invalid: FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY must be copied from the same Firebase service-account JSON (same project as FIREBASE_PROJECT_ID). Re-run both wrangler secret put commands with a freshly downloaded key.",
      );
    }
    if (/invalid_grant|invalid jwt/i.test(desc)) {
      throw new Error(
        `Firebase service account key rejected (${desc}). Regenerate the JSON key in Firebase Console and set both Worker secrets again from that single file.`,
      );
    }
    throw new Error(desc);
  }
  return json.access_token;
}

function parseIdentityToolkitError(text: string, status: number): string {
  let detail = text.slice(0, 400);
  try {
    const j = JSON.parse(text) as { error?: { message?: string } };
    if (j.error?.message) detail = j.error.message;
  } catch {
    if (/<!doctype html/i.test(text) || status === 404) {
      return "Firebase Auth API returned 404 — enable Identity Toolkit API for this project in Google Cloud Console.";
    }
  }
  if (/EMAIL_EXISTS/i.test(detail)) {
    return "That email is already registered in Firebase Auth for another account.";
  }
  if (/USER_NOT_FOUND/i.test(detail)) {
    return "No Firebase account exists for this member UID — they may need to sign in once, or fix firebaseUid in the database.";
  }
  if (/PERMISSION_DENIED|INSUFFICIENT_PERMISSION/i.test(detail)) {
    return "Firebase Admin lacks permission — grant the service account Firebase Authentication Admin (or roles/firebaseauth.admin) in Google Cloud IAM.";
  }
  return `Firebase Auth update failed (${status}): ${detail}`;
}

function projectToolkitPath(projectId: string, action: string): string {
  const pid = projectId.trim();
  if (!pid) throw new Error("FIREBASE_PROJECT_ID is required for Firebase Admin API calls");
  return `/projects/${encodeURIComponent(pid)}/${action}`;
}

async function identityToolkitPost(
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const token = await getAccessTokenFromServiceAccount();
  const res = await fetch(`${IDENTITY_TOOLKIT}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(parseIdentityToolkitError(text, res.status));
  }
  if (!text.trim()) return {};
  return JSON.parse(text) as Record<string, unknown>;
}

/** Admin lookup by email (OAuth). Returns first user or null. */
export async function identityToolkitLookupByEmail(
  projectId: string,
  email: string,
): Promise<{ localId: string; email?: string } | null> {
  const normalized = normalizeEmail(email);
  const out = await identityToolkitPost(projectToolkitPath(projectId, "accounts:lookup"), {
    email: [normalized],
  });
  const users = (out.users as Array<{ localId?: string; email?: string }> | undefined) ?? [];
  const u = users[0];
  if (!u?.localId) return null;
  return { localId: u.localId, email: u.email };
}

/**
 * Admin update email and/or password (POST accounts:update + localId).
 * Same capability as firebase-admin `auth().updateUser()` on Nest.
 */
export async function identityToolkitPatchUser(
  projectId: string,
  localId: string,
  fields: { email?: string; password?: string },
): Promise<void> {
  const uid = localId.trim();
  if (!uid) throw new Error("Firebase UID is required");

  const body: Record<string, unknown> = {
    localId: uid,
    returnSecureToken: false,
  };
  if (fields.email !== undefined) body.email = normalizeEmail(fields.email);
  if (fields.password !== undefined) body.password = fields.password;

  if (fields.email === undefined && fields.password === undefined) return;

  await identityToolkitPost(projectToolkitPath(projectId, "accounts:update"), body);
}

export function normalizeMemberEmail(email: string): string {
  return normalizeEmail(email);
}

/** Server-side Firebase account create (FEAT-004 submit). */
export async function identityToolkitSignUp(
  projectId: string,
  email: string,
  password: string,
  displayName: string,
): Promise<{ localId: string; email?: string }> {
  const out = await identityToolkitPost(projectToolkitPath(projectId, "accounts:signUp"), {
    email: normalizeEmail(email),
    password,
    displayName,
    returnSecureToken: false,
  });
  const localId = String(out.localId ?? "");
  if (!localId) throw new Error("Firebase signUp did not return a uid");
  return { localId, email: typeof out.email === "string" ? out.email : email };
}

/** PASSWORD_RESET oob link so we send mail from b2ccoop@gmail.com ourselves. */
export async function identityToolkitPasswordResetLink(projectId: string, email: string): Promise<string> {
  const out = await identityToolkitPost(projectToolkitPath(projectId, "accounts:sendOobCode"), {
    requestType: "PASSWORD_RESET",
    email: normalizeEmail(email),
    returnOobLink: true,
  });
  const link = String(out.oobLink ?? "");
  if (!link) throw new Error("Firebase did not return a password-reset link");
  return link;
}
