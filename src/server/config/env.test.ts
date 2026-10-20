import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// env.ts는 모듈 로드 시점에 process.env를 읽으므로 stub 후 dynamic import로 검증한다.
// 빈 문자열 env 값이 기본값으로 대체되는지(빈 User-Agent로 요청이 나가 WAF 차단되는 사고 재현) 확인한다.
describe("env 기본값 처리", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("빈 CRAWL_USER_AGENT는 기본 봇 UA로 대체된다", async () => {
    vi.stubEnv("CRAWL_USER_AGENT", "");
    const { env } = await import("./env");
    expect(env.crawlUserAgent).toContain("myportal-bot");
  });

  it("설정된 CRAWL_USER_AGENT는 그대로 사용된다", async () => {
    vi.stubEnv("CRAWL_USER_AGENT", "custom-bot/9.9");
    const { env } = await import("./env");
    expect(env.crawlUserAgent).toBe("custom-bot/9.9");
  });

  it("기본 UA에는 APP_BASE_URL이 포함된다", async () => {
    vi.stubEnv("APP_BASE_URL", "https://portal.example.com/");
    vi.stubEnv("CRAWL_USER_AGENT", "");
    const { env } = await import("./env");
    expect(env.appBaseUrl).toBe("https://portal.example.com");
    expect(env.crawlUserAgent).toBe(
      "myportal-bot/0.1 (+https://portal.example.com)",
    );
  });
});

describe("LLM 환경변수", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("빈 LLM_API_BASE는 OpenAI 기본 엔드포인트로 대체된다", async () => {
    vi.stubEnv("LLM_API_BASE", "");
    const { env } = await import("./env");
    expect(env.llmApiBase).toBe("https://api.openai.com/v1");
  });

  it("빈 LLM_MODEL은 gpt-4o-mini로 대체된다", async () => {
    vi.stubEnv("LLM_MODEL", "");
    const { env } = await import("./env");
    expect(env.llmModel).toBe("gpt-4o-mini");
  });

  it("LLM_DAILY_LIMIT 기본값은 50, 시스템 기본값은 200이다", async () => {
    vi.stubEnv("LLM_DAILY_LIMIT", "");
    vi.stubEnv("LLM_DAILY_LIMIT_SYSTEM", "");
    const { env } = await import("./env");
    expect(env.llmDailyLimit).toBe(50);
    expect(env.llmDailyLimitSystem).toBe(200);
  });

  it("hasLlm은 API 키 유무로만 판정한다", async () => {
    vi.stubEnv("LLM_API_KEY", "");
    const a = await import("./env");
    expect(a.hasLlm()).toBe(false);
    vi.resetModules();
    vi.stubEnv("LLM_API_KEY", "sk-test");
    const b = await import("./env");
    expect(b.hasLlm()).toBe(true);
  });

  it("LLM 미설정이 validateEnv를 실패시키지 않는다", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://localhost/test");
    vi.stubEnv("LLM_API_KEY", "");
    const { validateEnv } = await import("./env");
    expect(() => validateEnv()).not.toThrow();
  });
});
