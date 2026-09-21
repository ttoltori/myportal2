// 모든 환경변수는 여기서 한 번에 읽고 검증한다 (CLAUDE.md §17).
// 핵심 코드에서 VERCEL_URL 같은 플랫폼 전용 변수는 직접 사용하지 않는다.

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === "") return fallback;
  return v === "true" || v === "1";
}

function int(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const env = {
  databaseUrl: process.env.DATABASE_URL ?? "",
  supabaseUrl: process.env.SUPABASE_URL ?? "",
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  appBaseUrl: (process.env.APP_BASE_URL ?? "http://localhost:3001").replace(
    /\/+$/,
    "",
  ),
  logLevel: process.env.LOG_LEVEL ?? "info",
  isProduction: process.env.NODE_ENV === "production",

  // 쉼표 구분 허용 이메일 목록. 비어 있으면 전체 허용.
  allowedEmails: (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  // Supabase Auth 없이도 로그인되게 하는 개발용 매직링크 모드
  authDevMode: bool(process.env.AUTH_DEV_MODE, true),
  sessionTtlDays: int(process.env.SESSION_TTL_DAYS, 30),

  internalApiSecret: process.env.INTERNAL_API_SECRET ?? "",
  crawlUserAgent:
    process.env.CRAWL_USER_AGENT ??
    `myportal-bot/0.1 (+${process.env.APP_BASE_URL ?? "http://localhost:3001"})`,

  llmApiBase: process.env.LLM_API_BASE ?? "",
  llmApiKey: process.env.LLM_API_KEY ?? "",
  llmModel: process.env.LLM_MODEL ?? "",

  smtpUrl: process.env.SMTP_URL ?? "",
  mailFrom: process.env.MAIL_FROM ?? "myportal <no-reply@myportal.local>",
};

export function validateEnv(): void {
  if (!env.databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env.local and configure it.",
    );
  }
}

export function hasSupabaseAuth(): boolean {
  return Boolean(env.supabaseUrl && env.supabaseServiceRoleKey);
}
