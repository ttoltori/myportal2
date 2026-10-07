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

// 빈 문자열로 설정된 변수도 "미설정"으로 간주해 기본값을 쓴다.
// (.env.example을 그대로 복사하면 `CRAWL_USER_AGENT=`처럼 빈 값이 들어가는데,
// ?? 연산자는 빈 문자열을 통과시켜 빈 User-Agent 헤더로 요청이 나가고
// WAF가 이를 봇으로 차단(403)하는 사고를 방지하기 위함이다.)
const appBaseUrl = (process.env.APP_BASE_URL ?? "http://localhost:3001")
  .trim()
  .replace(/\/+$/, "");
const crawlUserAgent =
  (process.env.CRAWL_USER_AGENT ?? "").trim() ||
  `myportal-bot/0.1 (+${appBaseUrl})`;

export const env = {
  databaseUrl: process.env.DATABASE_URL ?? "",
  supabaseUrl: process.env.SUPABASE_URL ?? "",
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  appBaseUrl,
  logLevel: process.env.LOG_LEVEL || "info",
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
  crawlUserAgent,

  llmApiBase: process.env.LLM_API_BASE ?? "",
  llmApiKey: process.env.LLM_API_KEY ?? "",
  llmModel: process.env.LLM_MODEL ?? "",

  smtpUrl: process.env.SMTP_URL ?? "",
  mailFrom:
    (process.env.MAIL_FROM ?? "").trim() ||
    "myportal <no-reply@myportal.local>",
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
