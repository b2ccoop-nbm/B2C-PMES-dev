-- FEAT-004 pre-check: report duplicate Participant.tinNo values.
-- Include this in the PR. Do NOT run against production Neon from the coding agent.
-- Safe to run on a disposable / staging Neon branch or local Postgres.

SELECT
  "tinNo",
  COUNT(*) AS row_count,
  ARRAY_AGG(id ORDER BY "createdAt") AS participant_ids,
  ARRAY_AGG(email ORDER BY "createdAt") AS emails
FROM "Participant"
WHERE "tinNo" IS NOT NULL
  AND BTRIM("tinNo") <> ''
GROUP BY "tinNo"
HAVING COUNT(*) > 1
ORDER BY row_count DESC, "tinNo";
