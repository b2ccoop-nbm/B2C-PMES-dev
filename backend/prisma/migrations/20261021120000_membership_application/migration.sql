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

-- Unique member ID (nullable values stay unique-per-value; multiple NULLs are allowed)
CREATE UNIQUE INDEX IF NOT EXISTS "Participant_memberIdNo_key" ON "Participant"("memberIdNo");

-- Optional unique TIN when present
CREATE UNIQUE INDEX IF NOT EXISTS "Participant_tinNo_unique_not_null"
  ON "Participant"("tinNo")
  WHERE "tinNo" IS NOT NULL AND BTRIM("tinNo") <> '';

-- CreateTable
CREATE TABLE "MembershipApplication" (
    "id" TEXT NOT NULL,
    "status" "MembershipApplicationStatus" NOT NULL DEFAULT 'DRAFT',
    "resumeTokenHash" TEXT NOT NULL,
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
