import { beforeEach, describe, expect, it, vi } from "vitest";
import { hasLlm } from "../../config/env";
import { analyzeListing } from "./analyze";
import { buildPageOutline } from "./analyze/page-outline";
import { fetchPage } from "./fetcher";
import { checkLlmQuota } from "./llm/usage";
import { renderPage } from "./render";
import { robotsAllowed } from "./robots";

vi.mock("../../config/db", () => ({ getDb: () => ({ query: vi.fn() }) }));
vi.mock("../../config/env", () => ({
  env: { llmApiBase: "https://llm.test/v1", llmApiKey: "test-key", llmModel: "test-model" },
  hasLlm: vi.fn(),
}));
vi.mock("./fetcher", () => ({ fetchPage: vi.fn() }));
vi.mock("./render", () => ({ renderPage: vi.fn() }));
vi.mock("./robots", () => ({ robotsAllowed: vi.fn() }));
vi.mock("./llm/usage", () => ({ checkLlmQuota: vi.fn(), recordLlmCall: vi.fn() }));
vi.mock("./analyze/page-outline", () => ({ buildPageOutline: vi.fn() }));

const URL_IN = "https://x.kr/list";
const LIST_HTML = `<html><head><title>공고 목록</title></head><body><ul>
  ${[1, 2, 3, 4].map((i) => `<li><a href="/v/${i}">제${i}회 전국 아이디어 공모전 모집 안내</a></li>`).join("")}
</ul></body></html>`;

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.mocked(robotsAllowed).mockResolvedValue(true);
  vi.mocked(hasLlm).mockReturnValue(true);
  vi.mocked(checkLlmQuota).mockResolvedValue(true);
  vi.mocked(fetchPage).mockResolvedValue({
    finalUrl: URL_IN,
    status: 200,
    contentType: "text/html",
    body: LIST_HTML,
    etag: null,
    lastModified: null,
  });
  vi.mocked(renderPage).mockResolvedValue({
    finalUrl: URL_IN,
    html: LIST_HTML,
    timings: { readyMs: 100, readyBy: "stabilized", grewByScroll: false },
  });
});

describe("analyzeListing — 개요 생성이 던질 때", () => {
  it("예외 대신 warn 단계를 남기고 패턴 추정으로 내려가 결과를 돌려준다", async () => {
    vi.mocked(buildPageOutline).mockImplementation(() => {
      throw new Error("outline boom");
    });

    const r = await analyzeListing({
      userId: "u1",
      url: URL_IN,
      sourceId: null,
      purpose: "analyze-fields",
    });

    expect(r.steps.find((s) => s.label === "페이지 개요 생성")).toMatchObject({ status: "warn" });
    // 빈 개요라 LLM은 건너뛰고 폴백 휴리스틱이 목록을 찾는다.
    expect(r.outcome?.rows).toHaveLength(4);
    expect(r.fieldSource).toBe("heuristic");
    // 사용자에게 보이는 단계에 예외 원문이 새지 않는다.
    expect(JSON.stringify(r.steps)).not.toContain("outline boom");
  });
});
