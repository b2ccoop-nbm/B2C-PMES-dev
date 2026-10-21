export function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; message?: string };
  if (e?.code === "P2002" || e?.code === "23505") return true;
  return /unique constraint|duplicate key value/i.test(String(e?.message ?? ""));
}
