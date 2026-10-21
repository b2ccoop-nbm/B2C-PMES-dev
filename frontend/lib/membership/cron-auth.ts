/** Fail-closed cron auth: an unset secret is never an open door. */
export function authorizeCronSecret(
  expected: string | null | undefined,
  provided: string | null | undefined,
): { ok: true } | { ok: false; status: 401; message: string } {
  const want = String(expected ?? "").trim();
  const got = String(provided ?? "").trim();
  if (!want || got !== want) {
    return { ok: false, status: 401, message: "Unauthorized" };
  }
  return { ok: true };
}
