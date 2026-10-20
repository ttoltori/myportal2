import { beforeEach, describe, expect, it, vi } from "vitest";
import { hasLlm } from "../../../config/env";
import type { CrawlSpec, ExtractedRow } from "../extract";
import { enrichWithLlm } from "./enrich";
import {
  inferFields,
  inferListAndFields,
  validateInferredFields,
  type InferredField,
  type ValidatedFields,
} from "./field-inference";
import { LlmError } from "./llm-client";
import { checkLlmQuota, recordLlmCall } from "./usage";

vi.mock("../../../config/env", () => ({
  env: {
    llmApiBase: "https://api.test/v1",
    llmApiKey: "sk-test-key",
    llmModel: "test-model",
  },
  hasLlm: vi.fn(),
}));
vi.mock("./usage", () => ({
  checkLlmQuota: vi.fn(),
  recordLlmCall: vi.fn(),
}));
vi.mock("./field-inference", () => ({
  inferFields: vi.fn(),
  inferListAndFields: vi.fn(),
  validateInferredFields: vi.fn(),
}));

const HTML = "<ul><li class='row'>x</li></ul>";
const PAGE_URL = "https://x.kr/list";

function makeRows(n: number): ExtractedRow[] {
  return Array.from({ length: n }, (_, i) => ({
    title: `제목${i}`,
    link: `https://x.kr/v/${i}`,
    publishedAt: null,
    attrs: {},
  }));
}

const baseSpec: CrawlSpec = {
  strategy: "html",
  itemSelector: "li.row",
  fields: {},
};
const base = { spec: baseSpec, rows: makeRows(5) };

function field(key: string): InferredField {
  return {
    key,
    label: key,
    selector: `.${key}`,
    type: "text",
    role: "none",
  };
}

function validated(
  accepted: InferredField[],
  rowCount: number,
): ValidatedFields {
  return {
    spec: { ...baseSpec, fields: {}, fieldSource: "llm" },
    rows: makeRows(rowCount),
    accepted,
    rejected: [],
  };
}

function inferOk<T>(data: T) {
  return {
    data,
    promptTokens: 120,
    completionTokens: 45,
    durationMs: 350,
  };
}

function args(overrides: Partial<Parameters<typeof enrichWithLlm>[0]> = {}) {
  return {
    html: HTML,
    pageUrl: PAGE_URL,
    base,
    userId: "user-1",
    sourceId: null,
    purpose: "analyze-fields" as const,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(hasLlm).mockReturnValue(true);
  vi.mocked(checkLlmQuota).mockResolvedValue(true);
  vi.mocked(recordLlmCall).mockResolvedValue(undefined);
});

describe("enrichWithLlm", () => {
  it("LLM 미설정이면 base를 그대로 돌려주고 warn 단계를 만든다", async () => {
    vi.mocked(hasLlm).mockReturnValue(false);

    const result = await enrichWithLlm(args());

    expect(result?.fieldSource).toBe("heuristic");
    expect(result?.spec).toBe(base.spec);
    expect(result?.rows).toBe(base.rows);
    expect(result?.step.label).toBe("AI 필드 분석");
    expect(result?.step.status).toBe("warn");
    expect(result?.step.detail).toContain("설정");
    expect(inferFields).not.toHaveBeenCalled();
    expect(checkLlmQuota).not.toHaveBeenCalled();
  });

  it("상한 초과면 base를 그대로 돌려주고 warn 단계를 만든다", async () => {
    vi.mocked(checkLlmQuota).mockResolvedValue(false);

    const result = await enrichWithLlm(args());

    expect(result?.fieldSource).toBe("heuristic");
    expect(result?.step.status).toBe("warn");
    expect(result?.step.detail).toContain("한도");
    expect(inferFields).not.toHaveBeenCalled();
    expect(recordLlmCall).not.toHaveBeenCalled();
  });

  it("보강 성공 시 채택 필드 수를 단계에 담는다", async () => {
    vi.mocked(inferFields).mockResolvedValue(
      inferOk({ fields: [field("org"), field("due"), field("views")] }),
    );
    vi.mocked(validateInferredFields).mockReturnValue(
      validated([field("org"), field("due"), field("views")], 5),
    );

    const result = await enrichWithLlm(args());

    expect(result?.fieldSource).toBe("llm");
    expect(result?.step.status).toBe("ok");
    expect(result?.step.detail).toContain("3");
    expect(result?.spec.fieldSource).toBe("llm");
    expect(validateInferredFields).toHaveBeenCalledWith(
      HTML,
      PAGE_URL,
      base.spec,
      expect.any(Array),
      "enrich",
    );
  });

  it("구제 성공 시 추출 항목 수를 단계에 담는다", async () => {
    vi.mocked(inferListAndFields).mockResolvedValue(
      inferOk({ itemSelector: "li.row", fields: [field("org")] }),
    );
    vi.mocked(validateInferredFields).mockReturnValue(
      validated([field("org")], 24),
    );

    const result = await enrichWithLlm(
      args({ base: null, purpose: "analyze-rescue" }),
    );

    expect(result?.fieldSource).toBe("llm");
    expect(result?.step.status).toBe("ok");
    expect(result?.step.detail).toContain("24");
    expect(result?.rows).toHaveLength(24);
    expect(validateInferredFields).toHaveBeenCalledWith(
      HTML,
      PAGE_URL,
      expect.objectContaining({ strategy: "html", itemSelector: "li.row" }),
      expect.any(Array),
      "rescue",
    );
  });

  it("구제 모드에서 통과 필드가 0개여도 목록이 유효하면 성공으로 처리한다", async () => {
    vi.mocked(inferListAndFields).mockResolvedValue(
      inferOk({ itemSelector: "li.row", fields: [] }),
    );
    vi.mocked(validateInferredFields).mockReturnValue(validated([], 12));

    const result = await enrichWithLlm(
      args({ base: null, purpose: "analyze-rescue" }),
    );

    expect(result?.fieldSource).toBe("llm");
    expect(result?.step.status).toBe("ok");
    expect(result?.step.detail).toContain("12");
  });

  it("LlmError가 나도 예외를 던지지 않고 base를 돌려준다", async () => {
    vi.mocked(inferFields).mockRejectedValue(new LlmError("boom", "timeout"));

    const result = await enrichWithLlm(args());

    expect(result?.fieldSource).toBe("heuristic");
    expect(result?.spec).toBe(base.spec);
    expect(result?.rows).toBe(base.rows);
    expect(result?.step.status).toBe("warn");
    expect(result?.step.detail).toBe("AI 분석 시간이 초과되었습니다");
  });

  it("base가 null이고 구제도 실패하면 null을 반환한다", async () => {
    vi.mocked(inferListAndFields).mockResolvedValue(
      inferOk({ itemSelector: "nav a", fields: [] }),
    );
    vi.mocked(validateInferredFields).mockReturnValue(null);

    const result = await enrichWithLlm(
      args({ base: null, purpose: "analyze-rescue" }),
    );

    expect(result).toBeNull();
  });

  it("검증이 전부 폐기하면 base를 돌려준다", async () => {
    vi.mocked(inferFields).mockResolvedValue(
      inferOk({ fields: [field("bad")] }),
    );
    vi.mocked(validateInferredFields).mockReturnValue(null);

    const result = await enrichWithLlm(args());

    expect(result?.fieldSource).toBe("heuristic");
    expect(result?.spec).toBe(base.spec);
    expect(result?.step.status).toBe("warn");
    expect(result?.step.detail).toBe("추론된 필드가 유효하지 않습니다");
  });

  it("성공·실패 모두 recordLlmCall로 기록한다", async () => {
    vi.mocked(inferFields).mockResolvedValueOnce(
      inferOk({ fields: [field("org")] }),
    );
    vi.mocked(validateInferredFields).mockReturnValue(
      validated([field("org")], 5),
    );
    await enrichWithLlm(args({ sourceId: "src-1", purpose: "rebuild" }));

    expect(recordLlmCall).toHaveBeenLastCalledWith({
      userId: "user-1",
      sourceId: "src-1",
      purpose: "rebuild",
      model: "test-model",
      promptTokens: 120,
      completionTokens: 45,
      durationMs: 350,
      ok: true,
      errorCode: null,
    });

    vi.mocked(inferFields).mockRejectedValueOnce(new LlmError("x", "http"));
    await enrichWithLlm(args());

    expect(recordLlmCall).toHaveBeenCalledTimes(2);
    expect(recordLlmCall).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ok: false,
        errorCode: "http",
        promptTokens: null,
        completionTokens: null,
      }),
    );
  });

  it("rss 전략은 호출하지 않는다", async () => {
    const rssBase = {
      spec: { strategy: "rss", feedUrl: "https://x.kr/feed" } as CrawlSpec,
      rows: makeRows(3),
    };

    const result = await enrichWithLlm(args({ base: rssBase }));

    expect(result?.fieldSource).toBe("heuristic");
    expect(result?.spec).toBe(rssBase.spec);
    expect(result?.step.status).toBe("warn");
    expect(inferFields).not.toHaveBeenCalled();
    expect(checkLlmQuota).not.toHaveBeenCalled();
    expect(recordLlmCall).not.toHaveBeenCalled();
  });

  it("오류 메시지에 프로바이더 원문이 들어가지 않는다", async () => {
    vi.mocked(inferFields).mockRejectedValue(
      new LlmError("upstream: invalid_api_key sk-real", "http"),
    );

    const result = await enrichWithLlm(args());

    expect(result?.step.status).toBe("warn");
    expect(result?.step.detail).not.toContain("sk-real");
    expect(result?.step.detail).not.toContain("upstream");
    expect(result?.step.detail).toBe("AI 분석 호출에 실패했습니다");
    // 원문은 서버 로그에만 남는다.
    expect(console.error).toHaveBeenCalled();
  });

  it("예상치 못한 예외도 던지지 않는다", async () => {
    vi.mocked(checkLlmQuota).mockRejectedValue(new Error("db down"));

    const result = await enrichWithLlm(args());
    expect(result?.fieldSource).toBe("heuristic");
    expect(result?.step.status).toBe("warn");

    const rescue = await enrichWithLlm(args({ base: null }));
    expect(rescue).toBeNull();
  });
});
