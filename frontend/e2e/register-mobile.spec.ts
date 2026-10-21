import { expect, test } from "@playwright/test";

test("mobile register stepper auto-saves and reaches review", async ({ page }) => {
  await page.route("**/membership/applications", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          id: "app-e2e",
          status: "DRAFT",
          email: "e2e@example.com",
          mobile: "+639171234567",
          shareCapitalAmount: 1000,
          shareCapitalPaid: false,
          membershipFeePaid: false,
          resumeToken: "token-e2e",
          dpaConsentAt: new Date().toISOString(),
        }),
      });
      return;
    }
    await route.fallback();
  });
  await page.route("**/membership/applications/app-e2e", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ application: { id: "app-e2e", status: "DRAFT", email: "e2e@example.com" }, warnings: [] }),
    });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/register");
  await expect(page.getByRole("heading", { name: /apply for membership/i })).toBeVisible();
  await expect(page.getByTestId("turnstile-widget")).toBeVisible();
  await page.getByLabel("Email").fill("e2e@example.com");
  await page.getByLabel("Mobile").fill("09171234567");
  await page.getByText(/data privacy act/i).click();
  await page.getByRole("button", { name: /continue/i }).click();
  await expect(page.getByText("Personal")).toBeVisible();
  await page.getByLabel("First name").fill("Juan");
  await page.getByLabel("Last name").fill("Cruz");
  await page.getByRole("button", { name: /next/i }).click();
  await expect(page.getByLabel("City / municipality")).toBeVisible();
});
