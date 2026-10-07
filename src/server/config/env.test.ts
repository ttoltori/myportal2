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
