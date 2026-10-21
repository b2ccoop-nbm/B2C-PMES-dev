import { isGmailSendingEnabled, sendMembershipEmail } from "./mailer";
import { resumeEmail } from "./email-templates";

describe("gmail mailer flag", () => {
  const prev = process.env.GMAIL_SENDING_ENABLED;

  afterEach(() => {
    if (prev === undefined) delete process.env.GMAIL_SENDING_ENABLED;
    else process.env.GMAIL_SENDING_ENABLED = prev;
  });

  it("is off by default and mocks sends", async () => {
    delete process.env.GMAIL_SENDING_ENABLED;
    expect(isGmailSendingEnabled()).toBe(false);
    const out = await sendMembershipEmail(resumeEmail({ to: "a@test.com", continueUrl: "https://example.test/c" }));
    expect(out.mocked).toBe(true);
    expect(out.delivered).toBe(false);
  });
});
