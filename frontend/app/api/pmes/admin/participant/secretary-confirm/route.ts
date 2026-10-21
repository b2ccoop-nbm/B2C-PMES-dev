import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";
import { EDGE_CORS_HEADERS, edgeCorsOptions } from "@/lib/edge-cors";
import { requireStaff, forbidden, unauthorized } from "@/lib/staff-edge-auth";
import { BOD_MAJORITY_APPROVALS } from "@/lib/pmes-edge/board-workflow.constants";
import { toLifecyclePayload } from "@/lib/pmes-edge/admin-lifecycle";
import { selectAdminLifecycleRowByParticipantId } from "@/lib/pmes-edge/admin-participant-queries";
import { assertPmesPassedForSecretary, forcePmesOverrideAudit } from "@/lib/membership/pmes-gate";
import { syncApplicationFromParticipant } from "@/lib/membership/edge-service";

const MONTHS = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
] as const;

export function OPTIONS() {
  return edgeCorsOptions();
}

export async function POST(request: Request) {
  try {
    const staff = await requireStaff(request);
    if (staff.role !== "superuser" && staff.role !== "secretary") {
      return forbidden("Only the Secretary (or Superuser) may issue the Board resolution.", EDGE_CORS_HEADERS);
    }

    const sql = getSql();
    const actorRows = await sql`
      SELECT role FROM "StaffUser" WHERE id = ${staff.sub} LIMIT 1
    `;
    const actor = (actorRows as { role: string }[])[0];
    if (!actor) {
      return NextResponse.json(
        { message: "Staff account not found", statusCode: 403 },
        { status: 403, headers: EDGE_CORS_HEADERS },
      );
    }
    if (staff.role === "secretary" && actor.role !== "SECRETARY") {
      return forbidden("Your account is not the Secretary.", EDGE_CORS_HEADERS);
    }

    const body = (await request.json().catch(() => null)) as { participantId?: string; forcePmesOverride?: boolean } | null;
    const participantId = String(body?.participantId ?? "").trim();
    if (!participantId) {
      return NextResponse.json(
        { message: "participantId is required", statusCode: 400 },
        { status: 400, headers: EDGE_CORS_HEADERS },
      );
    }

    const pre = await sql`
      SELECT "boardApprovedAt", "bodMajorityReachedAt", "initialFeesPaidAt"
      FROM "Participant"
      WHERE id = ${participantId}
      LIMIT 1
    `;
    const p = (pre as {
      boardApprovedAt: string | null;
      bodMajorityReachedAt: string | null;
      initialFeesPaidAt: string | null;
    }[])[0];
    if (!p) {
      return NextResponse.json({ message: "Participant not found", statusCode: 404 }, { status: 404, headers: EDGE_CORS_HEADERS });
    }
    if (!p.initialFeesPaidAt) {
      return NextResponse.json(
        {
          message: "Treasurer must confirm fee payment before a Board Resolution can be issued.",
          statusCode: 400,
        },
        { status: 400, headers: EDGE_CORS_HEADERS },
      );
    }
    if (p.boardApprovedAt) {
      return NextResponse.json(
        { message: "Board approval is already recorded.", statusCode: 400 },
        { status: 400, headers: EDGE_CORS_HEADERS },
      );
    }
    if (!p.bodMajorityReachedAt) {
      return NextResponse.json(
        {
          message: `BOD majority (${BOD_MAJORITY_APPROVALS} approving votes) is required before the Secretary can issue a resolution.`,
          statusCode: 400,
        },
        { status: 400, headers: EDGE_CORS_HEADERS },
      );
    }

    const pmesRows = await sql`
      SELECT id FROM "PmesRecord" WHERE "participantId" = ${participantId} AND passed = true LIMIT 1
    `;
    const pmesPassed = (pmesRows as { id: string }[]).length > 0;
    const force = body?.forcePmesOverride === true;
    const gate = assertPmesPassedForSecretary(pmesPassed, {
      force,
      actorRole: staff.role,
    });
    if (!gate.ok) {
      return NextResponse.json({ message: gate.message, statusCode: 400 }, { status: 400, headers: EDGE_CORS_HEADERS });
    }
    const audit = forcePmesOverrideAudit({
      participantId,
      actorRole: staff.role,
      force,
      pmesPassed,
    });
    if (audit.shouldLog) {
      console.warn(audit.message);
    }

    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;
    const labelPrefix = `${MONTHS[month - 1]}-${year}-`;

    const updated = await sql`
      WITH ctr AS (
        INSERT INTO "BoardResolutionCounter" ("year", "month", "lastSeq")
        VALUES (${year}, ${month}, 1)
        ON CONFLICT ("year", "month")
        DO UPDATE SET "lastSeq" = "BoardResolutionCounter"."lastSeq" + 1
        RETURNING "lastSeq"
      )
      UPDATE "Participant" p
      SET
        "boardResolutionNo" = ${labelPrefix} || lpad(ctr."lastSeq"::text, 3, '0'),
        "boardApprovedAt" = NOW()
      FROM ctr
      WHERE p.id = ${participantId}
        AND p."boardApprovedAt" IS NULL
        AND p."bodMajorityReachedAt" IS NOT NULL
      RETURNING p.id
    `;

    const row = (updated as { id: string }[])[0];
    if (!row) {
      return NextResponse.json(
        { message: "Could not record resolution (participant state may have changed).", statusCode: 400 },
        { status: 400, headers: EDGE_CORS_HEADERS },
      );
    }

    const lifecycleRow = await selectAdminLifecycleRowByParticipantId(sql, participantId);
    if (!lifecycleRow) {
      return NextResponse.json({ message: "Participant not found", statusCode: 404 }, { status: 404, headers: EDGE_CORS_HEADERS });
    }

    await syncApplicationFromParticipant(participantId);
    return NextResponse.json(toLifecyclePayload(lifecycleRow), { headers: EDGE_CORS_HEADERS });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unauthorized";
    return unauthorized(message);
  }
}
