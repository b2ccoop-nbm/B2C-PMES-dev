import { GMAIL_FROM, type EmailTemplate } from "./email-templates";

export type MailDelivery = {
  delivered: boolean;
  mocked: boolean;
  reason?: string;
  id?: string;
};

export function isGmailSendingEnabled(): boolean {
  const flag = String(process.env.GMAIL_SENDING_ENABLED ?? "").trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}

export function hasGmailOauthConfig(): boolean {
  return Boolean(
    process.env.GMAIL_OAUTH_CLIENT_ID?.trim() &&
      process.env.GMAIL_OAUTH_CLIENT_SECRET?.trim() &&
      process.env.GMAIL_OAUTH_REFRESH_TOKEN?.trim(),
  );
}

async function gmailAccessToken(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: String(process.env.GMAIL_OAUTH_CLIENT_ID ?? "").trim(),
      client_secret: String(process.env.GMAIL_OAUTH_CLIENT_SECRET ?? "").trim(),
      refresh_token: String(process.env.GMAIL_OAUTH_REFRESH_TOKEN ?? "").trim(),
    }),
  });
  const json = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!res.ok || !json.access_token) {
    throw new Error(json.error_description || json.error || `Gmail OAuth failed (${res.status})`);
  }
  return json.access_token;
}

function rfc2822(template: EmailTemplate, from: string): string {
  return [
    `From: B2C Cooperative <${from}>`,
    `To: ${template.to}`,
    `Subject: ${template.subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/html; charset="UTF-8"',
    "",
    template.html,
  ].join("\r\n");
}

function base64Url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function sendMembershipEmail(template: EmailTemplate): Promise<MailDelivery> {
  if (!isGmailSendingEnabled()) {
    return { delivered: false, mocked: true, reason: "GMAIL_SENDING_ENABLED is off" };
  }
  if (!hasGmailOauthConfig()) {
    return { delivered: false, mocked: true, reason: "Gmail OAuth secrets are not configured" };
  }

  const from = String(process.env.GMAIL_FROM ?? GMAIL_FROM).trim() || GMAIL_FROM;
  const token = await gmailAccessToken();
  const raw = base64Url(rfc2822(template, from));
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw }),
  });
  const json = (await res.json()) as { id?: string; error?: { message?: string } };
  if (!res.ok) {
    throw new Error(json.error?.message || `Gmail send failed (${res.status})`);
  }
  return { delivered: true, mocked: false, id: json.id };
}
