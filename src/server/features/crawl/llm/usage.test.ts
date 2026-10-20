import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();

vi.mock("../../../config/db", () => ({
  getDb: () => ({ query: queryMock }),
}));
vi.mock("../../../config/env", () => ({
  env: { llmDailyLimit: 50, llmDailyLimitSystem: 200 },
}));

import { checkLlmQuota, recordLlmCall, type LlmCallEntry } from "./usage";

const entry: LlmCallEntry = {
  userId: "user-1",
  sourceId: "source-1",
  purpose: "analyze-fields",
  model: "gpt-4o-mini",
  promptTokens: 100,
  completionTokens: 20,
  durationMs: 850,
  ok: true,
  errorCode: null,
};

beforeEach(() => {
  queryMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("checkLlmQuota", () => {
  it("당일 성공 호출이 상한 미만이면 통과한다", async () => {
    queryMock.mockResolvedValue({ rows: [{ count: "49" }] });
    expect(await checkLlmQuota("user-1")).toBe(true);
  });

  it("상한과 같으면 차단한다", async () => {
    queryMock.mockResolvedValue({ rows: [{ count: "50" }] });
    expect(await checkLlmQuota("user-1")).toBe(false);
  });

  it("userId가 null이면 시스템 상한을 적용한다", async () => {
    queryMock.mockResolvedValue({ rows: [{ count: "150" }] });
    expect(await checkLlmQuota(null)).toBe(true);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("user_id is null");
    expect(params ?? []).toEqual([]);

    queryMock.mockResolvedValue({ rows: [{ count: "200" }] });
    expect(await checkLlmQuota(null)).toBe(false);
  });

  it("userId가 있으면 user_id = $1로 파라미터 바인딩한다", async () => {
    queryMock.mockResolvedValue({ rows: [{ count: "0" }] });
    await checkLlmQuota("user-1");
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("user_id = $1");
    expect(params).toEqual(["user-1"]);
  });

  it("상한 판정 쿼리가 실패하면 차단한다", async () => {
    // fail-closed: 판정 불가 상태에서 호출을 열면 비용 폭주를 막을 수 없다.
    queryMock.mockRejectedValue(new Error("connection refused"));
    expect(await checkLlmQuota("user-1")).toBe(false);
  });
});

describe("recordLlmCall", () => {
  it("성공·실패 모두 기록한다", async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await recordLlmCall({ ...entry, ok: false, errorCode: "LLM_TIMEOUT" });
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("insert into myportal.llm_calls");
    expect(params).toEqual([
      "user-1",
      "source-1",
      "analyze-fields",
      "gpt-4o-mini",
      100,
      20,
      850,
      false,
      "LLM_TIMEOUT",
    ]);
  });

  it("DB 오류는 삼켜진다", async () => {
    queryMock.mockRejectedValue(new Error("db down"));
    await expect(recordLlmCall(entry)).resolves.toBeUndefined();
  });
});
