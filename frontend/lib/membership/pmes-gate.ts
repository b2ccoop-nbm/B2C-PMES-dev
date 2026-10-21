export const PMES_REQUIRED_MESSAGE = "PMES not completed";

export function assertPmesPassedForSecretary(
  passed: boolean,
  opts?: { force?: boolean; actorRole?: string },
): { ok: true } | { ok: false; message: string } {
  if (passed) return { ok: true };
  const force = opts?.force === true;
  const superuser = opts?.actorRole === "superuser";
  if (force && superuser) return { ok: true };
  return { ok: false, message: PMES_REQUIRED_MESSAGE };
}
