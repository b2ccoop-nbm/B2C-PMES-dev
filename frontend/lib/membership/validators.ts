export const MIN_SHARE_CAPITAL = 1000;
export const MEMBERSHIP_FEE_DEFAULT = 500;
export const MIN_AGE_YEARS = 18;
export const DPA_CONSENT_VERSION_DEFAULT = "2026-10-21";
export const GCASH_REF_DIGITS = 13;
export const MEMBER_ID_COLLISION_RETRIES = 5;
export const DRAFT_TTL_DAYS = 60;

export function normalizeEmail(email: string): string {
  return String(email ?? "").trim().toLowerCase();
}

export function normalizeTinDigits(raw: string | null | undefined): string {
  return String(raw ?? "").replace(/\D/g, "");
}

export function normalizeFullName(raw: string | null | undefined): string {
  return String(raw ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

export function normalizePhMobile(raw: string | null | undefined): string | null {
  const digits = String(raw ?? "").replace(/\D/g, "");
  let national = digits;
  if (national.startsWith("63") && national.length === 12) national = national.slice(2);
  else if (national.startsWith("0") && national.length === 11) national = national.slice(1);
  if (!/^9\d{9}$/.test(national)) return null;
  return `+63${national}`;
}

export function isValidEmail(raw: string | null | undefined): boolean {
  const e = normalizeEmail(String(raw ?? ""));
  return e.length > 3 && e.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

export function isValidTin(raw: string | null | undefined): boolean {
  const d = normalizeTinDigits(raw);
  return d.length >= 9 && d.length <= 12;
}

export function parseIsoDateOnly(raw: string | Date | null | undefined): Date | null {
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return new Date(Date.UTC(raw.getUTCFullYear(), raw.getUTCMonth(), raw.getUTCDate()));
  }
  const s = String(raw ?? "").trim();
  if (!s || /^pending$/i.test(s)) return null;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!iso) return null;
  const y = Number(iso[1]);
  const m = Number(iso[2]);
  const d = Number(iso[3]);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

export function isAtLeastMinAge(dob: Date, on: Date = new Date()): boolean {
  let age = on.getUTCFullYear() - dob.getUTCFullYear();
  const md = on.getUTCMonth() - dob.getUTCMonth();
  if (md < 0 || (md === 0 && on.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age >= MIN_AGE_YEARS;
}

export function validateShareCapital(amount: unknown): number | null {
  const n = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(n) || n < MIN_SHARE_CAPITAL) return null;
  return Math.round(n * 100) / 100;
}

export function validateGcashRef(raw: string | null | undefined): string | null {
  const d = String(raw ?? "").replace(/\D/g, "");
  return d.length === GCASH_REF_DIGITS ? d : null;
}

export type PaymentModeValue = "CASH" | "GCASH";

export function parsePaymentMode(raw: unknown): PaymentModeValue | null {
  const v = String(raw ?? "").trim().toUpperCase();
  return v === "CASH" || v === "GCASH" ? v : null;
}

export function formatDobIso(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export type FieldIssue = { field: string; message: string };

export function validateDraftField(field: string, value: unknown): FieldIssue | null {
  switch (field) {
    case "email":
      return isValidEmail(String(value ?? "")) ? null : { field, message: "Enter a valid email address." };
    case "mobile":
      if (value == null || String(value).trim() === "") return null;
      return normalizePhMobile(String(value)) ? null : { field, message: "Enter a Philippine mobile number (09XXXXXXXXX)." };
    case "tinNo":
      if (value == null || String(value).trim() === "") return null;
      return isValidTin(String(value)) ? null : { field, message: "TIN must be 9–12 digits." };
    case "dob": {
      const d = parseIsoDateOnly(value as string);
      if (!d) return { field, message: "Enter a valid date of birth." };
      if (!isAtLeastMinAge(d)) return { field, message: "Applicants must be at least 18 years old." };
      return null;
    }
    case "shareCapitalAmount":
      return validateShareCapital(value) ? null : { field, message: "Initial share capital must be at least ₱1,000." };
    case "gcashRefNo":
      if (value == null || String(value).trim() === "") return null;
      return validateGcashRef(String(value)) ? null : { field, message: "GCash reference must be 13 digits." };
    default:
      return null;
  }
}

export function composeFullName(first?: string | null, middle?: string | null, last?: string | null, fallback?: string | null): string {
  const parts = [first, middle, last].map((p) => String(p ?? "").trim()).filter(Boolean);
  return parts.length ? parts.join(" ") : String(fallback ?? "").trim();
}

export function formatMailingAddress(addr: {
  street?: string;
  barangay?: string;
  cityMunicipality?: string;
  province?: string;
  zip?: string;
} | null | undefined): string {
  if (!addr) return "";
  return [addr.street, addr.barangay, addr.cityMunicipality, addr.province, addr.zip]
    .map((p) => String(p ?? "").trim())
    .filter(Boolean)
    .join(", ");
}

export function validateSubmitPayload(input: {
  fullName: string;
  dob: string | Date | null;
  gender: string | null;
  email: string;
  mobile: string | null;
  tinNo?: string | null;
  residentialAddress?: { cityMunicipality?: string; province?: string } | null;
  shareCapitalAmount?: number;
  shareCapitalPaid?: boolean;
  membershipFeePaid?: boolean;
  paymentMode?: string | null;
  gcashRefNo?: string | null;
  dpaConsentAt?: string | Date | null;
}): FieldIssue[] {
  const issues: FieldIssue[] = [];
  if (!String(input.fullName ?? "").trim()) issues.push({ field: "fullName", message: "Full name is required." });
  const dob = parseIsoDateOnly(input.dob);
  if (!dob) issues.push({ field: "dob", message: "Date of birth is required." });
  else if (!isAtLeastMinAge(dob)) issues.push({ field: "dob", message: "Applicants must be at least 18 years old." });
  if (!String(input.gender ?? "").trim()) issues.push({ field: "gender", message: "Gender is required." });
  if (!isValidEmail(input.email)) issues.push({ field: "email", message: "Enter a valid email address." });
  if (!normalizePhMobile(input.mobile)) issues.push({ field: "mobile", message: "Enter a Philippine mobile number (09XXXXXXXXX)." });
  if (input.tinNo && String(input.tinNo).trim() && !isValidTin(input.tinNo)) {
    issues.push({ field: "tinNo", message: "TIN must be 9–12 digits." });
  }
  if (!input.residentialAddress?.cityMunicipality || !input.residentialAddress?.province) {
    issues.push({ field: "residentialAddress", message: "City/municipality and province are required." });
  }
  if (validateShareCapital(input.shareCapitalAmount ?? MIN_SHARE_CAPITAL) == null) {
    issues.push({ field: "shareCapitalAmount", message: "Initial share capital must be at least ₱1,000." });
  }
  const mode = parsePaymentMode(input.paymentMode);
  if ((input.shareCapitalPaid || input.membershipFeePaid) && !mode) {
    issues.push({ field: "paymentMode", message: "Select Cash or GCash." });
  }
  if (mode === "GCASH" && !validateGcashRef(input.gcashRefNo)) {
    issues.push({ field: "gcashRefNo", message: "GCash reference (13 digits) is required when paying via GCash." });
  }
  if (!input.dpaConsentAt) issues.push({ field: "dpaConsent", message: "Data Privacy Act consent is required." });
  return issues;
}
