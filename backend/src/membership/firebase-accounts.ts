import * as admin from "firebase-admin";
import { generateUnusablePassword } from "./tokens";

export type FirebaseUserLite = { localId: string; email?: string };

export type FirebaseAccountsPort = {
  lookupByEmail: (email: string) => Promise<FirebaseUserLite | null>;
  signUp: (email: string, password: string, displayName: string) => Promise<FirebaseUserLite>;
  /** Identity Toolkit sendOobCode PASSWORD_RESET — Firebase sends the email. */
  sendPasswordResetEmail: (email: string) => Promise<void>;
  deleteUser?: (uid: string) => Promise<void>;
};

async function sendPasswordResetViaIdentityToolkit(email: string): Promise<void> {
  const projectId = String(process.env.FIREBASE_PROJECT_ID ?? "").trim();
  if (!projectId) throw new Error("FIREBASE_PROJECT_ID is required");
  const cred = admin.apps[0]?.options.credential;
  if (!cred) throw new Error("Firebase Admin credential is not configured");
  const tok = await cred.getAccessToken();
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/accounts:sendOobCode`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tok.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ requestType: "PASSWORD_RESET", email: email.trim().toLowerCase() }),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text.slice(0, 300) || `Firebase sendOobCode failed (${res.status})`);
  }
}

export function firebasePortFromAdmin(auth: admin.auth.Auth): FirebaseAccountsPort {
  return {
    async lookupByEmail(email) {
      try {
        const u = await auth.getUserByEmail(email);
        return { localId: u.uid, email: u.email ?? email };
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === "auth/user-not-found") return null;
        throw e;
      }
    },
    async signUp(email, password, displayName) {
      const u = await auth.createUser({ email, password, displayName });
      return { localId: u.uid, email: u.email ?? email };
    },
    async sendPasswordResetEmail(email) {
      await sendPasswordResetViaIdentityToolkit(email);
    },
    async deleteUser(uid) {
      await auth.deleteUser(uid);
    },
  };
}

export async function createFirebaseMemberAccount(
  email: string,
  displayName: string,
  port: FirebaseAccountsPort,
): Promise<{ uid: string; created: boolean; passwordEmailSent: boolean }> {
  const existing = await port.lookupByEmail(email);
  if (existing) {
    const passwordEmailSent = await port
      .sendPasswordResetEmail(email)
      .then(() => true)
      .catch(() => false);
    return { uid: existing.localId, created: false, passwordEmailSent };
  }
  const created = await port.signUp(email, generateUnusablePassword(), displayName);
  const passwordEmailSent = await port
    .sendPasswordResetEmail(email)
    .then(() => true)
    .catch(() => false);
  return { uid: created.localId, created: true, passwordEmailSent };
}
