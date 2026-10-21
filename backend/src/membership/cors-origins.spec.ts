import { allowedCorsOrigins, isAllowedCorsOrigin } from "./cors-origins";

describe("CORS allowlist", () => {
  it("never treats * as allowed and only reflects listed origins", () => {
    expect(isAllowedCorsOrigin("*")).toBe(false);
    expect(isAllowedCorsOrigin("https://evil.example")).toBe(false);
    expect(isAllowedCorsOrigin("https://b2ccoop.com")).toBe(true);
    expect(allowedCorsOrigins({ PUBLIC_APP_URL: "https://preview.example" })).toContain("https://preview.example");
  });
});
