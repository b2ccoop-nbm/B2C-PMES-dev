import {
  hasFirebaseServiceAccountConfig,
  identityToolkitLookupByEmail,
  identityToolkitPasswordResetLink,
  identityToolkitSignUp,
} from "@/lib/firebase-admin-rest";
import { generateUnusablePassword } from "@/lib/membership/tokens";

function projectId(): string {
  const pid = String(process.env.FIREBASE_PROJECT_ID ?? "").trim();
  if (!pid) throw new Error("FIREBASE_PROJECT_ID is required");
  return pid;
}

export async function createFirebaseMemberAccount(
  email: string,
  displayName: string,
): Promise<{ uid: string; created: boolean; resetLink: string | null }> {
  if (!hasFirebaseServiceAccountConfig()) {
    if (String(process.env.MEMBERSHIP_FIREBASE_MOCK ?? "").trim() === "1") {
      return { uid: `mock-${email}`, created: true, resetLink: "https://example.test/reset" };
    }
    throw new Error("Firebase Admin is not configured; cannot create a login on submit.");
  }
  const pid = projectId();
  const existing = await identityToolkitLookupByEmail(pid, email);
  if (existing) {
    const resetLink = await identityToolkitPasswordResetLink(pid, email).catch(() => null);
    return { uid: existing.localId, created: false, resetLink };
  }
  const created = await identityToolkitSignUp(pid, email, generateUnusablePassword(), displayName);
  const resetLink = await identityToolkitPasswordResetLink(pid, email).catch(() => null);
  return { uid: created.localId, created: true, resetLink };
}
