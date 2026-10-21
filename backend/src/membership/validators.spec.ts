import {
  ageYearsOn,
  isAtLeastMinAge,
  isValidTin,
  normalizePhMobile,
  parseIsoDateOnly,
  validateGcashRef,
  validateShareCapital,
  validateSubmitPayload,
} from "./validators";

describe("membership validators", () => {
  it("requires age 18", () => {
    const today = new Date(Date.UTC(2026, 9, 21));
    const under = parseIsoDateOnly("2009-10-22")!;
    const just18 = parseIsoDateOnly("2008-10-21")!;
    expect(ageYearsOn(under, today)).toBe(16);
    expect(isAtLeastMinAge(under, today)).toBe(false);
    expect(isAtLeastMinAge(just18, today)).toBe(true);
  });

  it("normalizes PH mobile numbers", () => {
    expect(normalizePhMobile("09171234567")).toBe("+639171234567");
    expect(normalizePhMobile("+63 917 123 4567")).toBe("+639171234567");
    expect(normalizePhMobile("9171234567")).toBe("+639171234567");
    expect(normalizePhMobile("12345")).toBeNull();
  });

  it("validates TIN 9–12 digits", () => {
    expect(isValidTin("123-456-789")).toBe(true);
    expect(isValidTin("123456789012")).toBe(true);
    expect(isValidTin("12345678")).toBe(false);
    expect(isValidTin("")).toBe(false);
  });

  it("requires share capital ≥ 1000", () => {
    expect(validateShareCapital(1000)).toBe(1000);
    expect(validateShareCapital(999.99)).toBeNull();
    expect(validateShareCapital("1500")).toBe(1500);
  });

  it("requires 13-digit GCash refs", () => {
    expect(validateGcashRef("1234567890123")).toBe("1234567890123");
    expect(validateGcashRef("123")).toBeNull();
  });

  it("rejects under-18 submit payloads", () => {
    const issues = validateSubmitPayload({
      fullName: "Juan Dela Cruz",
      dob: "2015-01-01",
      gender: "male",
      email: "juan@example.com",
      mobile: "09171234567",
      residentialAddress: { cityMunicipality: "Cebu City", province: "Cebu" },
      shareCapitalAmount: 1000,
      dpaConsentAt: new Date(),
    });
    expect(issues.some((i) => i.field === "dob")).toBe(true);
  });

  it("requires GCash ref when mode is GCASH", () => {
    const issues = validateSubmitPayload({
      fullName: "Juan Dela Cruz",
      dob: "1990-01-01",
      gender: "male",
      email: "juan@example.com",
      mobile: "09171234567",
      residentialAddress: { cityMunicipality: "Cebu City", province: "Cebu" },
      shareCapitalAmount: 1000,
      shareCapitalPaid: true,
      paymentMode: "GCASH",
      dpaConsentAt: new Date(),
    });
    expect(issues.some((i) => i.field === "gcashRefNo")).toBe(true);
  });
});
