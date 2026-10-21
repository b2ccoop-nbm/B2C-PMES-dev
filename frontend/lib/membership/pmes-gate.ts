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

export function forcePmesOverrideAudit(input: {
  participantId: string;
  actorRole: string;
  force: boolean;
  pmesPassed: boolean;
}): { shouldLog: boolean; message: string } {
  const shouldLog = input.force === true && input.actorRole === "superuser" && !input.pmesPassed;
  return {
    shouldLog,
    message: `Superuser forced secretary/board approval without PMES for participant ${input.participantId}`,
  };
}
