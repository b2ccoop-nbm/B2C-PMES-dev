/** Chairperson / Vice Chairperson / GM use JWT `admin` but may cast BOD votes (see staff login `dbRole`). */
const BOARD_OFFICER_DB_ROLES = ["CHAIRMAN", "VICE_CHAIRMAN", "GENERAL_MANAGER"];

/**
 * UI + inbox: who may see BOD vote actions (JWT + optional Prisma `dbRole` from login).
 */
export function canCastBodVote(jwtRole, dbRole) {
  if (!jwtRole) return false;
  if (jwtRole === "superuser" || jwtRole === "board_director") return true;
  if (jwtRole === "admin" && dbRole && BOARD_OFFICER_DB_ROLES.includes(dbRole)) return true;
  return false;
}

/**
 * Count pipeline rows by cooperative stage for staff inbox prompts (Treasurer / BOD / Secretary).
 * Mirrors `toLifecyclePayload` stages in the API.
 */
export function countMembershipInboxByStage(rows) {
  const out = { treasurer: 0, bod: 0, secretary: 0, onlinePayments: 0 };
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    const st = String(r.stage || "");
    if (st === "AWAITING_PAYMENT") {
      out.treasurer += 1;
      out.onlinePayments += 1;
    }
    else if (st === "AWAITING_BOD_VOTE") out.bod += 1;
    else if (st === "AWAITING_SECRETARY_RESOLUTION") out.secretary += 1;
  }
  return out;
}

/**
 * @param {string | null} role — staff JWT role
 * @param {{ treasurer: number; bod: number; secretary: number }} counts
 * @param {string | null | undefined} dbRole — Prisma StaffUser.role from login (e.g. CHAIRMAN)
 * @returns {null | { lines: string[] }}
 */
export function staffPipelineInboxSummary(role, counts, dbRole) {
  if (!role || !counts) return null;
  const lines = [];
  const isTreasurer = role === "treasurer";
  const isSecretary = role === "secretary";
  const isAdmin = role === "admin" || role === "superuser";
  const showBodInbox =
    counts.bod > 0 &&
    (role === "board_director" ||
      role === "superuser" ||
      (role === "admin" && dbRole && BOARD_OFFICER_DB_ROLES.includes(dbRole)));

  if (isAdmin || isTreasurer) {
    if (counts.treasurer > 0) {
      lines.push(
        `${counts.treasurer} member application${counts.treasurer === 1 ? "" : "s"} need fee confirmation (Treasurer).`,
      );
    }
    if (counts.onlinePayments > 0) {
      lines.push(
        `${counts.onlinePayments} online application${counts.onlinePayments === 1 ? "" : "s"} are in the Treasurer payments-to-confirm queue.`,
      );
    }
  }
  if (showBodInbox) {
    lines.push(
      `${counts.bod} member application${counts.bod === 1 ? "" : "s"} need Board of Directors approval votes.`,
    );
  }
  if (isAdmin || isSecretary) {
    if (counts.secretary > 0) {
      lines.push(
        `${counts.secretary} member application${counts.secretary === 1 ? "" : "s"} need Secretary resolution and final Board approval.`,
      );
    }
  }

  if (lines.length === 0) return null;
  return { lines };
}
