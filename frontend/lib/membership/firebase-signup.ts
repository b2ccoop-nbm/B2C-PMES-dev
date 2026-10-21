import {
  hasFirebaseServiceAccountConfig,
  identityToolkitDeleteUser,
  identityToolkitLookupByEmail,
  identityToolkitSendPasswordReset,
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
): Promise<{ uid: string; created: boolean; passwordEmailSent: boolean }> {
  if (!hasFirebaseServiceAccountConfig()) {
    if (String(process.env.MEMBERSHIP_FIREBASE_MOCK ?? "").trim() === "1") {
      return { uid: `mock-${email}`, created: true, passwordEmailSent: true };
    }
    throw new Error("Firebase Admin is not configured; cannot create a login on submit.");
  }
  const pid = projectId();
  const existing = await identityToolkitLookupByEmail(pid, email);
  if (existing) {
    const passwordEmailSent = await identityToolkitSendPasswordReset(pid, email)
      .then(() => true)
      .catch(() => false);
    return { uid: existing.localId, created: false, passwordEmailSent };
  }
  const created = await identityToolkitSignUp(pid, email, generateUnusablePassword(), displayName);
  const passwordEmailSent = await identityToolkitSendPasswordReset(pid, email)
    .then(() => true)
    .catch(() => false);
  return { uid: created.localId, created: true, passwordEmailSent };
}

export async function deleteFirebaseMemberAccount(uid: string): Promise<void> {
  if (!hasFirebaseServiceAccountConfig()) return;
  await identityToolkitDeleteUser(projectId(), uid);
}
