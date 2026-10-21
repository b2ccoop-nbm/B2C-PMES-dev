export const GMAIL_FROM = "b2ccoop@gmail.com";

export type EmailTemplate = {
  key:
    | "set_password"
    | "resume"
    | "treasurer_prompt"
    | "tin_reminder"
    | "approved"
    | "rejected";
  to: string;
  subject: string;
  text: string;
  html: string;
};

function wrapHtml(body: string): string {
  return `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#0f172a">${body}<p style="margin-top:2rem;font-size:12px;color:#64748b">B2C Cooperative · b2ccoop@gmail.com</p></body></html>`;
}

export function setPasswordEmail(input: { to: string; fullName: string; memberIdNo: string; setPasswordUrl: string }): EmailTemplate {
  const text = `Hello ${input.fullName},\n\nYour B2C membership application was received.\n\nLogin ID (member ID): ${input.memberIdNo}\nYou can sign in with this ID or your email after you set a password.\n\nSet your password:\n${input.setPasswordUrl}\n\nPayment is self-declared until the Treasurer confirms it. You may complete PMES any time after this email.\n`;
  return {
    key: "set_password",
    to: input.to,
    subject: `B2C membership — your login ID ${input.memberIdNo}`,
    text,
    html: wrapHtml(
      `<p>Hello ${escapeHtml(input.fullName)},</p><p>Your B2C membership application was received.</p><p><strong>Login ID:</strong> ${escapeHtml(input.memberIdNo)}</p><p><a href="${escapeAttr(input.setPasswordUrl)}">Set your password</a></p><p>Payment is self-declared until the Treasurer confirms it. You may complete PMES any time after this email.</p>`,
    ),
  };
}

export function resumeEmail(input: { to: string; continueUrl: string }): EmailTemplate {
  const text = `Continue your B2C membership application:\n${input.continueUrl}\n\nThis link works for 30 days while your draft is open.\n`;
  return {
    key: "resume",
    to: input.to,
    subject: "Continue your B2C membership application",
    text,
    html: wrapHtml(`<p>Continue your B2C membership application:</p><p><a href="${escapeAttr(input.continueUrl)}">Resume application</a></p><p>This link works for 30 days while your draft is open.</p>`),
  };
}

export function treasurerPromptEmail(input: {
  to: string;
  applicantName: string;
  applicantEmail: string;
  memberIdNo?: string | null;
  declaredPaid: boolean;
  paymentMode?: string | null;
  gcashRefNo?: string | null;
}): EmailTemplate {
  const text = `A membership application needs payment review.\n\nApplicant: ${input.applicantName} <${input.applicantEmail}>\nMember ID: ${input.memberIdNo ?? "(pending submit)"}\nDeclared paid: ${input.declaredPaid ? "yes" : "no"}\nMode: ${input.paymentMode ?? "—"}\nGCash ref: ${input.gcashRefNo ?? "—"}\n\nOpen the Treasurer “Payments to confirm” queue in the admin dashboard.\n`;
  return {
    key: "treasurer_prompt",
    to: input.to,
    subject: `Payments to confirm — ${input.applicantName}`,
    text,
    html: wrapHtml(`<p>A membership application needs payment review.</p><ul><li>Applicant: ${escapeHtml(input.applicantName)} &lt;${escapeHtml(input.applicantEmail)}&gt;</li><li>Member ID: ${escapeHtml(input.memberIdNo ?? "(pending submit)")}</li><li>Declared paid: ${input.declaredPaid ? "yes" : "no"}</li><li>Mode: ${escapeHtml(input.paymentMode ?? "—")}</li><li>GCash ref: ${escapeHtml(input.gcashRefNo ?? "—")}</li></ul><p>Open the Treasurer “Payments to confirm” queue.</p>`),
  };
}

export function tinReminderEmail(input: { to: string; fullName: string }): EmailTemplate {
  const text = `Hello ${input.fullName},\n\nYour membership record is missing a TIN. Please sign in and provide it when prompted. You will see this reminder until a TIN is saved.\n`;
  return {
    key: "tin_reminder",
    to: input.to,
    subject: "Please add your TIN to your B2C membership record",
    text,
    html: wrapHtml(`<p>Hello ${escapeHtml(input.fullName)},</p><p>Your membership record is missing a TIN. Please sign in and provide it when prompted.</p>`),
  };
}

export function approvedEmail(input: { to: string; fullName: string; memberIdNo: string }): EmailTemplate {
  const text = `Hello ${input.fullName},\n\nYour B2C membership has been approved. Your member ID ${input.memberIdNo} is now your official login ID.\n`;
  return {
    key: "approved",
    to: input.to,
    subject: `Membership approved — ${input.memberIdNo}`,
    text,
    html: wrapHtml(`<p>Hello ${escapeHtml(input.fullName)},</p><p>Your B2C membership has been approved. Your member ID <strong>${escapeHtml(input.memberIdNo)}</strong> is now your official login ID.</p>`),
  };
}

export function rejectedEmail(input: { to: string; fullName: string; reason: string }): EmailTemplate {
  const text = `Hello ${input.fullName},\n\nYour B2C membership application was not approved.\n\nReason: ${input.reason}\n\nYou may contact the Secretary if you have questions.\n`;
  return {
    key: "rejected",
    to: input.to,
    subject: "Update on your B2C membership application",
    text,
    html: wrapHtml(`<p>Hello ${escapeHtml(input.fullName)},</p><p>Your B2C membership application was not approved.</p><p>Reason: ${escapeHtml(input.reason)}</p>`),
  };
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, "&#39;");
}
