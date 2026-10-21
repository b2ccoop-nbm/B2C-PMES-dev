-- FEAT-004: online membership applications + unique member IDs
-- Do not apply this to production Neon from this PR. CI / local / staging only.

-- CreateEnum
CREATE TYPE "MembershipApplicationStatus" AS ENUM (
  'DRAFT',
  'SUBMITTED',
  'PAYMENT_CONFIRMED',
  'BOD_APPROVED',
  'APPROVED',
  'REJECTED',
  'WITHDRAWN',
  'EXPIRED'
);

-- CreateEnum
CREATE TYPE "PaymentMode" AS ENUM ('CASH', 'GCASH');

-- AlterTable Participant
ALTER TABLE "Participant" ADD COLUMN IF NOT EXISTS "tinMissingFlaggedAt" TIMESTAMP(3);
ALTER TABLE "Participant" ADD COLUMN IF NOT EXISTS "registrationSource" TEXT;

-- Normalize blanks to NULL so unique indexes do not collide on empty strings.
UPDATE "Participant" SET "memberIdNo" = NULL WHERE "memberIdNo" IS NOT NULL AND BTRIM("memberIdNo") = '';
UPDATE "Participant" SET "tinNo" = NULL WHERE "tinNo" IS NOT NULL AND BTRIM("tinNo") = '';

-- Fail closed if duplicates remain. Run the report scripts on a staging Neon branch first.
-- Do not apply this migration to live production Neon from this PR.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Participant"
    WHERE "memberIdNo" IS NOT NULL
    GROUP BY "memberIdNo"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate memberIdNo values exist. Run backend/scripts/report-duplicate-member-id-no.sql on a staging branch and resolve before migrating.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "Participant"
    WHERE "tinNo" IS NOT NULL
    GROUP BY "tinNo"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate tinNo values exist. Run backend/scripts/report-duplicate-tin-no.sql on a staging branch and resolve before migrating.';
  END IF;
END $$;

-- Unique member ID (nullable values stay unique-per-value; multiple NULLs are allowed)
CREATE UNIQUE INDEX IF NOT EXISTS "Participant_memberIdNo_key" ON "Participant"("memberIdNo");

-- Unique TIN when set (aligned with Prisma @@unique; blanks already normalized to NULL)
CREATE UNIQUE INDEX IF NOT EXISTS "Participant_tinNo_key" ON "Participant"("tinNo");

-- CreateTable
CREATE TABLE "MembershipApplication" (
    "id" TEXT NOT NULL,
    "status" "MembershipApplicationStatus" NOT NULL DEFAULT 'DRAFT',
    "resumeTokenHash" TEXT NOT NULL,
    "resumeTokenExpiresAt" TIMESTAMP(3),
    "pendingResumeTokenHash" TEXT,
    "pendingResumeTokenExpiresAt" TIMESTAMP(3),
    "participantId" TEXT,
    "fullName" TEXT,
    "firstName" TEXT,
    "middleName" TEXT,
    "lastName" TEXT,
    "dob" DATE,
    "gender" TEXT,
    "email" TEXT NOT NULL,
    "mobile" TEXT,
    "tinNo" TEXT,
    "residentialAddress" JSONB,
    "referredByParticipantId" TEXT,
    "shareCapitalAmount" DECIMAL(14,2) NOT NULL DEFAULT 1000,
    "shareCapitalPaid" BOOLEAN NOT NULL DEFAULT false,
    "membershipFeeAmount" DECIMAL(14,2) NOT NULL DEFAULT 500,
    "membershipFeePaid" BOOLEAN NOT NULL DEFAULT false,
    "paymentMode" "PaymentMode",
    "gcashRefNo" TEXT,
    "gcashScreenshotKey" TEXT,
    "paymentDeclaredAt" TIMESTAMP(3),
    "treasurerNotifiedAt" TIMESTAMP(3),
    "dpaConsentAt" TIMESTAMP(3),
    "dpaConsentVersion" TEXT,
    "consentIp" TEXT,
    "userAgent" TEXT,
    "possibleDuplicateOfId" TEXT,
    "submittedAt" TIMESTAMP(3),
    "paymentConfirmedAt" TIMESTAMP(3),
    "paymentConfirmedById" TEXT,
    "receiptNo" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MembershipApplication_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "MembershipApplication"
  ADD CONSTRAINT "MembershipApplication_shareCapital_min"
  CHECK ("shareCapitalAmount" >= 1000);

CREATE UNIQUE INDEX "MembershipApplication_resumeTokenHash_key" ON "MembershipApplication"("resumeTokenHash");
CREATE UNIQUE INDEX "MembershipApplication_pendingResumeTokenHash_key" ON "MembershipApplication"("pendingResumeTokenHash");
CREATE UNIQUE INDEX "MembershipApplication_participantId_key" ON "MembershipApplication"("participantId");
CREATE INDEX "MembershipApplication_status_idx" ON "MembershipApplication"("status");
CREATE INDEX "MembershipApplication_email_idx" ON "MembershipApplication"("email");
CREATE INDEX "MembershipApplication_mobile_idx" ON "MembershipApplication"("mobile");
CREATE INDEX "MembershipApplication_tinNo_idx" ON "MembershipApplication"("tinNo");

ALTER TABLE "MembershipApplication"
  ADD CONSTRAINT "MembershipApplication_participantId_fkey"
  FOREIGN KEY ("participantId") REFERENCES "Participant"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MembershipApplication"
  ADD CONSTRAINT "MembershipApplication_paymentConfirmedById_fkey"
  FOREIGN KEY ("paymentConfirmedById") REFERENCES "StaffUser"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "MembershipRateLimit" (
    "id" TEXT NOT NULL,
    "bucketKey" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "MembershipRateLimit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MembershipRateLimit_bucketKey_windowStart_key"
  ON "MembershipRateLimit"("bucketKey", "windowStart");
CREATE INDEX "MembershipRateLimit_bucketKey_idx" ON "MembershipRateLimit"("bucketKey");
