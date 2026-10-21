import * as admin from "firebase-admin";
import { generateUnusablePassword } from "./tokens";

export type FirebaseUserLite = { localId: string; email?: string };

export type FirebaseAccountsPort = {
  lookupByEmail: (email: string) => Promise<FirebaseUserLite | null>;
  signUp: (email: string, password: string, displayName: string) => Promise<FirebaseUserLite>;
  passwordResetLink: (email: string) => Promise<string>;
  deleteUser?: (uid: string) => Promise<void>;
};

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
    async passwordResetLink(email) {
      return auth.generatePasswordResetLink(email);
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
): Promise<{ uid: string; created: boolean; resetLink: string | null }> {
  const existing = await port.lookupByEmail(email);
  if (existing) {
    const resetLink = await port.passwordResetLink(email).catch(() => null);
    return { uid: existing.localId, created: false, resetLink };
  }
  const created = await port.signUp(email, generateUnusablePassword(), displayName);
  const resetLink = await port.passwordResetLink(email).catch(() => null);
  return { uid: created.localId, created: true, resetLink };
}
