import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";
import { EDGE_CORS_HEADERS, edgeCorsOptions } from "@/lib/edge-cors";
import { requireStaff, forbidden, unauthorized } from "@/lib/staff-edge-auth";
import { toLifecyclePayload } from "@/lib/pmes-edge/admin-lifecycle";
import { selectAdminLifecycleRowByParticipantId } from "@/lib/pmes-edge/admin-participant-queries";
import { syncApplicationFromParticipant } from "@/lib/membership/edge-service";

export function OPTIONS() {
  return edgeCorsOptions();
}

export async function POST(request: Request) {
  try {
    const staff = await requireStaff(request);
    if (staff.role !== "superuser" && staff.role !== "board_director") {
      return forbidden("Only Board directors (or Superuser) may cast BOD votes.", EDGE_CORS_HEADERS);
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
    if (staff.role === "board_director" && actor.role !== "BOARD_DIRECTOR") {
      return forbidden("Your account is not a Board director.", EDGE_CORS_HEADERS);
    }

    const body = (await request.json().catch(() => null)) as { participantId?: string; approve?: boolean } | null;
    const participantId = String(body?.participantId ?? "").trim();
    const approve = body?.approve === true;
    if (!participantId) {
      return NextResponse.json(
        { message: "participantId is required", statusCode: 400 },
        { status: 400, headers: EDGE_CORS_HEADERS },
      );
    }

    const pre = await sql`
      SELECT "boardApprovedAt", "initialFeesPaidAt" FROM "Participant" WHERE id = ${participantId} LIMIT 1
    `;
    const p = (pre as { boardApprovedAt: string | null; initialFeesPaidAt: string | null }[])[0];
    if (!p) {
      return NextResponse.json({ message: "Participant not found", statusCode: 404 }, { status: 404, headers: EDGE_CORS_HEADERS });
    }
    if (!p.initialFeesPaidAt) {
      return NextResponse.json(
        {
          message:
            "Treasurer must confirm fee payment before the Board can record votes on this application.",
          statusCode: 400,
        },
        { status: 400, headers: EDGE_CORS_HEADERS },
      );
    }
    if (p.boardApprovedAt) {
      return NextResponse.json(
        { message: "Board approval is already recorded for this member.", statusCode: 400 },
        { status: 400, headers: EDGE_CORS_HEADERS },
      );
    }

    await sql`
      INSERT INTO "BoardApprovalVote" ("participantId", "staffUserId", "approve")
      VALUES (${participantId}, ${staff.sub}, ${approve})
      ON CONFLICT ("participantId", "staffUserId")
      DO UPDATE SET "approve" = EXCLUDED."approve", "updatedAt" = NOW()
    `;

    await sql`
      UPDATE "Participant" p
      SET "bodMajorityReachedAt" = CASE
        WHEN p."initialFeesPaidAt" IS NOT NULL
          AND (
            SELECT COUNT(*)::int FROM "BoardApprovalVote" v
            WHERE v."participantId" = ${participantId} AND v.approve = true
          ) >= 3
        THEN COALESCE(p."bodMajorityReachedAt", NOW())
        ELSE NULL
      END
      WHERE p.id = ${participantId} AND p."boardApprovedAt" IS NULL
    `;

    const row = await selectAdminLifecycleRowByParticipantId(sql, participantId);
    if (!row) {
      return NextResponse.json({ message: "Participant not found", statusCode: 404 }, { status: 404, headers: EDGE_CORS_HEADERS });
    }

    await syncApplicationFromParticipant(participantId);
    return NextResponse.json(toLifecyclePayload(row), { headers: EDGE_CORS_HEADERS });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unauthorized";
    return unauthorized(message);
  }
}
