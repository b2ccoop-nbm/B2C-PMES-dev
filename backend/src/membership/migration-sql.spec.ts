import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("membership unique-index migration", () => {
  const sql = readFileSync(
    join(__dirname, "../../prisma/migrations/20261021120000_membership_application/migration.sql"),
    "utf8",
  );

  it("normalizes blank member IDs and TINs before unique indexes", () => {
    expect(sql).toMatch(/SET "memberIdNo" = NULL/);
    expect(sql).toMatch(/SET "tinNo" = NULL/);
    expect(sql).toMatch(/RAISE EXCEPTION 'Duplicate memberIdNo/);
    expect(sql).toMatch(/RAISE EXCEPTION 'Duplicate tinNo/);
    expect(sql).toMatch(/Participant_tinNo_key/);
    expect(sql).not.toMatch(/Participant_tinNo_unique_not_null/);
  });
});
