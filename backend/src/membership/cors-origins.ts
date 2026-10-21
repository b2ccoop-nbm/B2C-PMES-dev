const DEFAULT_ORIGINS = [
  "https://b2ccoop.com",
  "https://www.b2ccoop.com",
  "http://localhost:5173",
  "http://localhost:3000",
  "http://localhost:3040",
  "http://localhost:4173",
];

export function allowedCorsOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const extras = String(env.MEMBERSHIP_CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
  const pub = String(env.PUBLIC_APP_URL ?? "")
    .trim()
    .replace(/\/$/, "");
  return [...new Set([...DEFAULT_ORIGINS, pub, ...extras].filter(Boolean))];
}

export function isAllowedCorsOrigin(origin: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!origin) return false;
  return allowedCorsOrigins(env).includes(origin.replace(/\/$/, ""));
}
