import { assertPmesPassedForSecretary, PMES_REQUIRED_MESSAGE } from "./pmes-gate";

describe("PMES secretary gate", () => {
  it("allows a passed PMES record", () => {
    expect(assertPmesPassedForSecretary(true).ok).toBe(true);
  });

  it("blocks secretary confirm until PMES is passed", () => {
    const out = assertPmesPassedForSecretary(false, { actorRole: "secretary" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toBe(PMES_REQUIRED_MESSAGE);
  });

  it("allows superuser force override only", () => {
    expect(assertPmesPassedForSecretary(false, { force: true, actorRole: "secretary" }).ok).toBe(false);
    expect(assertPmesPassedForSecretary(false, { force: true, actorRole: "superuser" }).ok).toBe(true);
  });
});
