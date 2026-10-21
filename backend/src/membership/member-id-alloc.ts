import { buildMemberPublicId, cohortYYFromDob, initialsFromFirstLast, initialsFromFullName } from "../pmes/member-public-id";
import { isUniqueViolation } from "./unique-violation";
import { MEMBER_ID_COLLISION_RETRIES } from "./validators";

export async function allocateMemberPublicId(opts: {
  fullName: string;
  firstName?: string | null;
  lastName?: string | null;
  dob: string;
  createdAt?: Date;
  exists: (id: string) => Promise<boolean>;
  tryInsert?: (id: string) => Promise<void>;
  maxAttempts?: number;
}): Promise<string> {
  const initials =
    opts.firstName && opts.lastName
      ? initialsFromFirstLast(opts.firstName, opts.lastName, opts.fullName)
      : initialsFromFullName(opts.fullName);
  const yy = cohortYYFromDob(opts.dob, opts.createdAt ?? new Date());
  const attempts = opts.maxAttempts ?? MEMBER_ID_COLLISION_RETRIES;
  for (let i = 0; i < attempts; i++) {
    const id = buildMemberPublicId(initials, yy);
    if (opts.tryInsert) {
      try {
        await opts.tryInsert(id);
        return id;
      } catch (e) {
        if (isUniqueViolation(e)) continue;
        throw e;
      }
    }
    if (!(await opts.exists(id))) return id;
  }
  throw new Error(`Could not allocate a unique member ID after ${attempts} retries.`);
}

export function referrerIsApproved(row: { boardApprovedAt: Date | string | null } | null | undefined): boolean {
  return Boolean(row?.boardApprovedAt);
}

export function maskGivenName(fullName: string): string {
  const parts = String(fullName ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "Member";
  const first = parts[0]!;
  const lastInitial = parts.length > 1 ? `${parts[parts.length - 1]!.slice(0, 1).toUpperCase()}.` : "";
  return lastInitial ? `${first} ${lastInitial}` : first;
}
