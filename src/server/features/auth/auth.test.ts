import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// env는 모듈 로드 시점에 process.env를 읽으므로 stub 후 동적 import한다
// (config/env.test.ts와 같은 방식).
async function loadAuth(stubs: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(stubs)) vi.stubEnv(k, v);
  return import("./auth");
}

const MASTER_EMAIL = "owner@example.com";

describe("isMasterKey", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("키가 일치하면 true", async () => {
    const { isMasterKey } = await loadAuth({
      AUTH_MASTER_KEY: "s3cret-phrase",
      AUTH_MASTER_EMAIL: MASTER_EMAIL,
    });
    expect(isMasterKey("s3cret-phrase")).toBe(true);
  });

  it("키가 다르면 false", async () => {
    const { isMasterKey } = await loadAuth({
      AUTH_MASTER_KEY: "s3cret-phrase",
      AUTH_MASTER_EMAIL: MASTER_EMAIL,
    });
    expect(isMasterKey("wrong")).toBe(false);
  });

  // 길이가 달라도 timingSafeEqual이 던지지 않아야 한다.
  // 해시 후 비교하므로 입력 길이와 무관하게 32바이트끼리 비교된다.
  it("길이가 크게 달라도 예외 없이 false", async () => {
    const { isMasterKey } = await loadAuth({
      AUTH_MASTER_KEY: "s3cret-phrase",
      AUTH_MASTER_EMAIL: MASTER_EMAIL,
    });
    expect(() => isMasterKey("")).not.toThrow();
    expect(isMasterKey("")).toBe(false);
    expect(isMasterKey("x".repeat(5000))).toBe(false);
  });

  it("AUTH_MASTER_KEY가 없으면 기능이 꺼진다", async () => {
    const { isMasterKey } = await loadAuth({
      AUTH_MASTER_KEY: "",
      AUTH_MASTER_EMAIL: MASTER_EMAIL,
    });
    expect(isMasterKey("")).toBe(false);
    expect(isMasterKey("아무거나")).toBe(false);
  });

  // 키만 있고 계정이 없으면 어느 사용자로 로그인할지 정할 수 없다.
  it("AUTH_MASTER_EMAIL이 없으면 키가 맞아도 false", async () => {
    const { isMasterKey } = await loadAuth({
      AUTH_MASTER_KEY: "s3cret-phrase",
      AUTH_MASTER_EMAIL: "",
    });
    expect(isMasterKey("s3cret-phrase")).toBe(false);
  });

  it("앞뒤 공백이 있는 입력은 일치하지 않는다", async () => {
    const { isMasterKey } = await loadAuth({
      AUTH_MASTER_KEY: "s3cret-phrase",
      AUTH_MASTER_EMAIL: MASTER_EMAIL,
    });
    expect(isMasterKey(" s3cret-phrase ")).toBe(false);
  });
});

describe("issueMagicLink", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // 계약에서 이메일 형식 검증을 뺐으므로(로그인 키가 같은 칸을 쓴다)
  // 형식이 아닌 입력이 DB까지 내려가면 안 된다.
  it("이메일 형식이 아니면 DB를 건드리지 않고 조용히 반환한다", async () => {
    const query = vi.fn();
    vi.doMock("../../config/db", () => ({ getDb: () => ({ query }) }));
    const { issueMagicLink } = await loadAuth({
      AUTH_DEV_MODE: "true",
      ALLOWED_EMAILS: "",
    });

    const r = await issueMagicLink("ttoltoriisking");
    expect(r).toEqual({ sent: true });
    expect(r.devLink).toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  // 어떤 계정이 등록돼 있는지 노출하지 않기 위해 성공처럼 응답한다.
  it("허용 목록 밖 이메일도 조용히 반환한다", async () => {
    const query = vi.fn();
    vi.doMock("../../config/db", () => ({ getDb: () => ({ query }) }));
    const { issueMagicLink } = await loadAuth({
      AUTH_DEV_MODE: "true",
      ALLOWED_EMAILS: "owner@example.com",
    });

    const r = await issueMagicLink("someone@else.com");
    expect(r).toEqual({ sent: true });
    expect(query).not.toHaveBeenCalled();
  });
});
