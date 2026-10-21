import { normalizeEmail, normalizeFullName, normalizePhMobile, normalizeTinDigits, parseIsoDateOnly } from "./validators";

export type DupKind = "email" | "mobile" | "tin" | "name_dob" | "legacy" | "open_application";

export type DupAction = "block" | "flag" | "resume" | "reclaim";

export type DupFinding = {
  kind: DupKind;
  action: DupAction;
  message: string;
  participantId?: string;
  applicationId?: string;
};

export type ExistingParticipantLite = {
  id: string;
  email: string;
  phone: string | null;
  tinNo: string | null;
  fullName: string;
  dob: string | Date | null;
  boardApprovedAt: Date | string | null;
  legacyPioneerImport: boolean;
};

export type ExistingApplicationLite = {
  id: string;
  email: string;
  status: string;
};

export type DuplicateLookup = {
  findParticipantByEmail: (email: string) => Promise<ExistingParticipantLite | null>;
  findParticipantByMobile: (mobile: string) => Promise<ExistingParticipantLite | null>;
  findParticipantByTin: (tin: string) => Promise<ExistingParticipantLite | null>;
  findParticipantByNameDob: (fullName: string, dobIso: string) => Promise<ExistingParticipantLite | null>;
  findOpenApplicationByEmail: (email: string) => Promise<ExistingApplicationLite | null>;
  firebaseEmailExists?: (email: string) => Promise<boolean>;
};

export type DuplicateInput = {
  email: string;
  mobile?: string | null;
  tinNo?: string | null;
  fullName?: string | null;
  dob?: string | Date | null;
  excludeApplicationId?: string | null;
};

const EMAIL_BLOCK = "Already registered — sign in or reset password";
const TIN_BLOCK = "This TIN is already on file. Contact the Secretary.";
const MOBILE_FLAG = "This mobile number matches an existing application. Staff will review.";
const NAME_DOB_FLAG = "A similar name and date of birth is already on file. Staff will review.";
const LEGACY_RECLAIM = "A pioneer roster row matches this identity. Use the reclaim flow instead of a new application.";
const OPEN_RESUME = "An open application already exists for this email.";

export async function evaluateDuplicates(input: DuplicateInput, lookup: DuplicateLookup): Promise<DupFinding[]> {
  const findings: DupFinding[] = [];
  const email = normalizeEmail(input.email);

  const open = await lookup.findOpenApplicationByEmail(email);
  if (open && open.id !== input.excludeApplicationId) {
    findings.push({
      kind: "open_application",
      action: "resume",
      message: OPEN_RESUME,
      applicationId: open.id,
    });
  }

  const byEmail = await lookup.findParticipantByEmail(email);
  const firebaseHit = lookup.firebaseEmailExists ? await lookup.firebaseEmailExists(email) : false;
  if (byEmail || firebaseHit) {
    findings.push({
      kind: "email",
      action: "block",
      message: EMAIL_BLOCK,
      participantId: byEmail?.id,
    });
  }

  const mobile = input.mobile ? normalizePhMobile(input.mobile) : null;
  if (mobile) {
    const byMobile = await lookup.findParticipantByMobile(mobile);
    if (byMobile) {
      if (byMobile.boardApprovedAt) {
        findings.push({
          kind: "mobile",
          action: "block",
          message: "This mobile number belongs to an approved member. Sign in or contact the Secretary.",
          participantId: byMobile.id,
        });
      } else {
        findings.push({
          kind: "mobile",
          action: "flag",
          message: MOBILE_FLAG,
          participantId: byMobile.id,
        });
      }
    }
  }

  const tin = normalizeTinDigits(input.tinNo);
  if (tin) {
    const byTin = await lookup.findParticipantByTin(tin);
    if (byTin) {
      if (byTin.legacyPioneerImport) {
        findings.push({
          kind: "legacy",
          action: "reclaim",
          message: LEGACY_RECLAIM,
          participantId: byTin.id,
        });
      } else {
        findings.push({
          kind: "tin",
          action: "block",
          message: TIN_BLOCK,
          participantId: byTin.id,
        });
      }
    }
  }

  const name = normalizeFullName(input.fullName);
  const dob = parseIsoDateOnly(input.dob ?? null);
  if (name && dob) {
    const dobIso = `${dob.getUTCFullYear()}-${String(dob.getUTCMonth() + 1).padStart(2, "0")}-${String(dob.getUTCDate()).padStart(2, "0")}`;
    const byName = await lookup.findParticipantByNameDob(name, dobIso);
    if (byName) {
      if (byName.legacyPioneerImport) {
        findings.push({
          kind: "legacy",
          action: "reclaim",
          message: LEGACY_RECLAIM,
          participantId: byName.id,
        });
      } else {
        findings.push({
          kind: "name_dob",
          action: "flag",
          message: NAME_DOB_FLAG,
          participantId: byName.id,
        });
      }
    }
  }

  return findings;
}

export function blockingFinding(findings: DupFinding[]): DupFinding | undefined {
  return findings.find((f) => f.action === "block" || f.action === "reclaim");
}

export function firstFlaggedParticipantId(findings: DupFinding[]): string | null {
  const flag = findings.find((f) => f.action === "flag" && f.participantId);
  return flag?.participantId ?? null;
}

export function resumeApplicationId(findings: DupFinding[]): string | null {
  return findings.find((f) => f.action === "resume")?.applicationId ?? null;
}
