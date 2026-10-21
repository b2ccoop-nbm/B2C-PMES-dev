import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";
import { assertMemberEmailMatchesFirebaseToken } from "@/lib/pmes-edge/member-bearer";
import { normalizeEmail } from "@/lib/pmes-edge/norm";
import { isMissingMemberProfileStampColumnError } from "@/lib/pmes-edge/pg-stamp-fallback";
import { isValidTin, normalizeTinDigits } from "@/lib/membership/validators";

type Body = {
  email?: string;
  fullName?: string;
  phone?: string;
  dob?: string;
  gender?: string;
  mailingAddress?: string;
  tinNo?: string;
};

export async function PATCH(request: Request) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ message: "Invalid JSON body" }, { status: 400 });
  }

  const emailRaw = String(body.email ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw) || emailRaw.length > 320) {
    return NextResponse.json({ message: "email must be valid", statusCode: 400 }, { status: 400 });
  }
  const email = normalizeEmail(emailRaw);

  try {
    await assertMemberEmailMatchesFirebaseToken(request.headers.get("authorization"), email);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unauthorized";
    if (msg.startsWith("UNAUTHORIZED:")) {
      return NextResponse.json(
        { message: msg.replace(/^UNAUTHORIZED:\s*/, ""), statusCode: 401 },
        { status: 401 },
      );
    }
    return NextResponse.json({ message: msg, statusCode: 401 }, { status: 401 });
  }

  const data: {
    fullName?: string;
    phone?: string;
    dob?: string;
    gender?: string;
    mailingAddress?: string | null;
  } = {};

  if (body.fullName !== undefined) {
    const t = String(body.fullName).trim();
    if (!t) {
      return NextResponse.json({ message: "fullName cannot be empty", statusCode: 400 }, { status: 400 });
    }
    data.fullName = t.slice(0, 500);
  }
  if (body.phone !== undefined) {
    const t = String(body.phone).trim();
    if (!t) {
      return NextResponse.json({ message: "phone cannot be empty", statusCode: 400 }, { status: 400 });
    }
    data.phone = t.slice(0, 64);
  }
  if (body.dob !== undefined) {
    const t = String(body.dob).trim();
    if (!t) {
      return NextResponse.json({ message: "dob cannot be empty", statusCode: 400 }, { status: 400 });
    }
    data.dob = t.slice(0, 32);
  }
  if (body.gender !== undefined) {
    const t = String(body.gender).trim();
    if (!t) {
      return NextResponse.json({ message: "gender cannot be empty", statusCode: 400 }, { status: 400 });
    }
    data.gender = t.slice(0, 32);
  }
  if (body.mailingAddress !== undefined) {
    const t = String(body.mailingAddress).trim();
    data.mailingAddress = t ? t.slice(0, 4000) : null;
  }
  let tinNo: string | null | undefined;
  if (body.tinNo !== undefined) {
    const digits = normalizeTinDigits(body.tinNo);
    if (digits && !isValidTin(digits)) {
      return NextResponse.json({ message: "TIN must be 9–12 digits.", statusCode: 400 }, { status: 400 });
    }
    tinNo = digits || null;
  }

  if (Object.keys(data).length === 0 && tinNo === undefined) {
    return NextResponse.json({ message: "Provide at least one field to update.", statusCode: 400 }, { status: 400 });
  }

  const sql = getSql();

  const found = await sql`
    SELECT id FROM "Participant" WHERE email = ${email} LIMIT 1
  `;
  const row = (found as { id: string }[])[0];
  if (!row) {
    return NextResponse.json({ message: "Participant not found", statusCode: 404 }, { status: 404 });
  }

  const fullName = data.fullName;
  const phone = data.phone;
  const dob = data.dob;
  const gender = data.gender;
  const mailingAddress = data.mailingAddress;

  if (tinNo !== undefined) {
    if (tinNo) {
      const clash = await sql`
        SELECT id FROM "Participant" WHERE "tinNo" = ${tinNo} AND email <> ${email} LIMIT 1
      `;
      if ((clash as { id: string }[]).length) {
        return NextResponse.json(
          { message: "This TIN is already on file. Contact the Secretary.", statusCode: 409 },
          { status: 409 },
        );
      }
    }
    try {
      await sql`
        UPDATE "Participant"
        SET
          "tinNo" = ${tinNo},
          "tinMissingFlaggedAt" = ${tinNo ? null : new Date()},
          "memberProfileConcurrencyStamp" = "memberProfileConcurrencyStamp" + 1
        WHERE id = ${row.id}::uuid
      `;
    } catch (e) {
      if (!isMissingMemberProfileStampColumnError(e)) throw e;
      await sql`
        UPDATE "Participant"
        SET "tinNo" = ${tinNo}, "tinMissingFlaggedAt" = ${tinNo ? null : new Date()}
        WHERE id = ${row.id}::uuid
      `;
    }
    if (Object.keys(data).length === 0) {
      return NextResponse.json({ success: true as const });
    }
  }

  try {
    if (
      fullName !== undefined &&
      phone !== undefined &&
      dob !== undefined &&
      gender !== undefined &&
      mailingAddress !== undefined
    ) {
      try {
        await sql`
          UPDATE "Participant"
          SET
            "fullName" = ${fullName},
            phone = ${phone},
            dob = ${dob},
            gender = ${gender},
            "mailingAddress" = ${mailingAddress},
            "memberProfileConcurrencyStamp" = "memberProfileConcurrencyStamp" + 1
          WHERE id = ${row.id}::uuid
        `;
      } catch (e) {
        if (!isMissingMemberProfileStampColumnError(e)) throw e;
        await sql`
          UPDATE "Participant"
          SET
            "fullName" = ${fullName},
            phone = ${phone},
            dob = ${dob},
            gender = ${gender},
            "mailingAddress" = ${mailingAddress}
          WHERE id = ${row.id}::uuid
        `;
      }
      return NextResponse.json({ success: true as const });
    }

    if (
      fullName !== undefined &&
      phone !== undefined &&
      dob !== undefined &&
      gender !== undefined &&
      mailingAddress === undefined
    ) {
      try {
        await sql`
          UPDATE "Participant"
          SET
            "fullName" = ${fullName},
            phone = ${phone},
            dob = ${dob},
            gender = ${gender},
            "memberProfileConcurrencyStamp" = "memberProfileConcurrencyStamp" + 1
          WHERE id = ${row.id}::uuid
        `;
      } catch (e) {
        if (!isMissingMemberProfileStampColumnError(e)) throw e;
        await sql`
          UPDATE "Participant"
          SET
            "fullName" = ${fullName},
            phone = ${phone},
            dob = ${dob},
            gender = ${gender}
          WHERE id = ${row.id}::uuid
        `;
      }
      return NextResponse.json({ success: true as const });
    }

    /** Single-field updates (e.g. staff tools) — match Nest `updateMemberBasicProfile`. */
    if (fullName !== undefined && phone === undefined && dob === undefined && gender === undefined) {
      try {
        await sql`
          UPDATE "Participant"
          SET
            "fullName" = ${fullName},
            "memberProfileConcurrencyStamp" = "memberProfileConcurrencyStamp" + 1
          WHERE id = ${row.id}::uuid
        `;
      } catch (e) {
        if (!isMissingMemberProfileStampColumnError(e)) throw e;
        await sql`
          UPDATE "Participant"
          SET "fullName" = ${fullName}
          WHERE id = ${row.id}::uuid
        `;
      }
      return NextResponse.json({ success: true as const });
    }
    if (phone !== undefined && fullName === undefined && dob === undefined && gender === undefined) {
      try {
        await sql`
          UPDATE "Participant"
          SET
            phone = ${phone},
            "memberProfileConcurrencyStamp" = "memberProfileConcurrencyStamp" + 1
          WHERE id = ${row.id}::uuid
        `;
      } catch (e) {
        if (!isMissingMemberProfileStampColumnError(e)) throw e;
        await sql`
          UPDATE "Participant"
          SET phone = ${phone}
          WHERE id = ${row.id}::uuid
        `;
      }
      return NextResponse.json({ success: true as const });
    }
    if (dob !== undefined && fullName === undefined && phone === undefined && gender === undefined) {
      try {
        await sql`
          UPDATE "Participant"
          SET
            dob = ${dob},
            "memberProfileConcurrencyStamp" = "memberProfileConcurrencyStamp" + 1
          WHERE id = ${row.id}::uuid
        `;
      } catch (e) {
        if (!isMissingMemberProfileStampColumnError(e)) throw e;
        await sql`
          UPDATE "Participant"
          SET dob = ${dob}
          WHERE id = ${row.id}::uuid
        `;
      }
      return NextResponse.json({ success: true as const });
    }
    if (gender !== undefined && fullName === undefined && phone === undefined && dob === undefined) {
      try {
        await sql`
          UPDATE "Participant"
          SET
            gender = ${gender},
            "memberProfileConcurrencyStamp" = "memberProfileConcurrencyStamp" + 1
          WHERE id = ${row.id}::uuid
        `;
      } catch (e) {
        if (!isMissingMemberProfileStampColumnError(e)) throw e;
        await sql`
          UPDATE "Participant"
          SET gender = ${gender}
          WHERE id = ${row.id}::uuid
        `;
      }
      return NextResponse.json({ success: true as const });
    }
    if (
      mailingAddress !== undefined &&
      fullName === undefined &&
      phone === undefined &&
      dob === undefined &&
      gender === undefined
    ) {
      try {
        await sql`
          UPDATE "Participant"
          SET
            "mailingAddress" = ${mailingAddress},
            "memberProfileConcurrencyStamp" = "memberProfileConcurrencyStamp" + 1
          WHERE id = ${row.id}::uuid
        `;
      } catch (e) {
        if (!isMissingMemberProfileStampColumnError(e)) throw e;
        await sql`
          UPDATE "Participant"
          SET "mailingAddress" = ${mailingAddress}
          WHERE id = ${row.id}::uuid
        `;
      }
      return NextResponse.json({ success: true as const });
    }

    return NextResponse.json(
      {
        message:
          "Combine fields as supported by the API (e.g. fullName+phone+dob+gender, or single-field updates).",
        statusCode: 400,
      },
      { status: 400 },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Update failed";
    return NextResponse.json({ message: msg, statusCode: 500 }, { status: 500 });
  }
}
