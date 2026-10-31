import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AnalyzeStep } from "@myportal/api-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasLlm } from "../../../config/env";
import { generateSpec } from "../extract";
import { LlmError } from "../llm/llm-client";
import { checkLlmQuota, recordLlmCall } from "../llm/usage";
import { readPage, readPageRepair, type PageReadResult } from "./llm-read";
import { buildPageOutline, type PageOutline } from "./page-outline";
import { runAnalysis, type RunAnalysisArgs } from "./run-analysis";
import { verifySpec } from "./verify";

vi.mock("../../../config/env", () => ({
  env: { llmApiBase: "https://llm.test/v1", llmApiKey: "test-key", llmModel: "test-model" },
  hasLlm: vi.fn(),
}));
vi.mock("../llm/usage", () => ({ checkLlmQuota: vi.fn(), recordLlmCall: vi.fn() }));
// 힌트 판정(hintMatchesOutline)은 실제 구현을 쓰고 LLM 호출만 교체한다.
vi.mock("./llm-read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./llm-read")>()),
  readPage: vi.fn(),
  readPageRepair: vi.fn(),
}));
// 폴백이 실제로 불렸는지 보기 위해 generateSpec만 실제 구현을 감싼다.
vi.mock("../extract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../extract")>();
  return { ...actual, generateSpec: vi.fn(actual.generateSpec) };
});
// 검증은 실제 구현을 감싸 두고, 필요한 테스트에서만 "미달" 판정을 한 번 강제한다.
vi.mock("./verify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./verify")>();
  return { ...actual, verifySpec: vi.fn(actual.verifySpec) };
});

const PAGE_URL = "https://www.example.kr/list";

const TITLES = [
  "2026년 AI 바우처 지원사업 공고",
  "데이터 활용 중소기업 모집 안내",
  "스마트공장 구축 지원사업 참여기업 공모",
  "수출 바우처 사업 수행기관 추가 모집",
];
const ORGS = ["정보통신산업진흥원", "한국데이터산업진흥원", "중소벤처기업진흥공단", "대한무역투자진흥공사"];

function loadFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}.html`, import.meta.url)), "utf-8");
}

const fold = (s: string | null): string => (s ?? "").replace(/\s+/g, " ").trim();

// 번호를 손으로 세지 않고 개요에서 텍스트로 찾는다.
function refOf(outline: PageOutline, text: string): number {
  const ref = outline.refs.findIndex((el) => el !== null && fold(el.textContent) === text);
  if (ref < 0) throw new Error(`개요에 "${text}"가 없다`);
  return ref;
}

function goodRead(outline: PageOutline, patch: Partial<PageReadResult> = {}): PageReadResult {
  return {
    pageKind: "list",
    pageTitle: "사업공고 (AI가 읽은 제목)",
    items: TITLES.map((title, i) => ({
      titleRef: refOf(outline, title),
      titleText: title,
      linkRef: refOf(outline, title),
      fields: [
        {
          key: "organization",
          label: "기관",
          type: "text",
          role: "none",
          ref: refOf(outline, ORGS[i]),
          text: ORGS[i],
        },
      ],
    })),
    suggested: { displayName: "진흥원 사업공고", categoryPath: ["지원사업", "공고"], tagNames: ["공고", "지원"] },
    ...patch,
  };
}

function llmResult(data: PageReadResult) {
  return { data, promptTokens: 100, completionTokens: 50, durationMs: 1234 };
}

const TABLE_HTML = loadFixture("table-board");

function argsFor(html: string, patch: Partial<RunAnalysisArgs> = {}): RunAnalysisArgs {
  return {
    html,
    pageUrl: PAGE_URL,
    outline: buildPageOutline(html),
    userId: "u1",
    sourceId: null,
    purpose: "analyze-fields",
    ...patch,
  };
}

// vi.mock이 감싼 verifySpec 대신 실제 구현을 직접 부르기 위해 원본을 따로 잡아 둔다.
const actualVerify = (await vi.importActual<typeof import("./verify")>("./verify")).verifySpec;

// 다음 verifySpec 한 번을 "전체 폐기" 판정으로 바꾼다. 행은 실제 추출 결과를 그대로 쓴다.
function rejectNextVerification(): void {
  vi.mocked(verifySpec).mockImplementationOnce((...a) => {
    const real = actualVerify(...a);
    return { rows: real.rows, score: { ...real.score, ok: false, rowYield: 0.3 } };
  });
}

function stepOf(steps: AnalyzeStep[], label: string) {
  return steps.find((s) => s.label === label);
}

beforeEach(() => {
  vi.mocked(hasLlm).mockReset().mockReturnValue(true);
  vi.mocked(checkLlmQuota).mockReset().mockResolvedValue(true);
  vi.mocked(recordLlmCall).mockReset().mockResolvedValue(undefined);
  vi.mocked(readPage).mockReset();
  vi.mocked(readPageRepair).mockReset();
  vi.mocked(verifySpec).mockReset().mockImplementation(actualVerify);
  vi.mocked(generateSpec).mockClear();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("runAnalysis — LLM 경로", () => {
  it("LLM이 목록을 읽으면 합성·검증을 거쳐 llm fieldSource로 돌려준다", async () => {
    const args = argsFor(TABLE_HTML);
    vi.mocked(readPage).mockResolvedValue(llmResult(goodRead(args.outline)));

    const r = await runAnalysis(args);

    expect(r.fieldSource).toBe("llm");
    expect(r.strategy).toBe("html");
    expect(r.spec?.itemSelector).toBeTruthy();
    expect(r.spec?.fieldSource).toBe("llm");
    expect(r.rows.map((x) => x.title)).toEqual(TITLES);
    expect(r.rows[0].attrs.organization).toBe(ORGS[0]);
    expect(r.pageKind).toBe("list");
    expect(stepOf(r.steps, "AI 페이지 해석")).toMatchObject({ status: "ok", detail: "목록 4건, 필드 1개" });
    expect(readPageRepair).not.toHaveBeenCalled();
  });

  it("검증 지표를 단계 detail에 적는다 (항목 수, 제목 일치율, 수율, 채택 필드 수)", async () => {
    const args = argsFor(TABLE_HTML);
    vi.mocked(readPage).mockResolvedValue(llmResult(goodRead(args.outline)));

    const r = await runAnalysis(args);

    expect(stepOf(r.steps, "셀렉터 합성·검증")).toMatchObject({
      status: "ok",
      detail: "항목 4건, 제목 일치율 100%, 수율 1.00, 필드 1개 채택",
    });
  });

  it("검증 미달이면 보수 호출을 1회 하고 그 결과를 쓴다", async () => {
    const args = argsFor(TABLE_HTML);
    vi.mocked(readPage).mockResolvedValue(llmResult(goodRead(args.outline)));
    const repaired = goodRead(args.outline, {
      suggested: { displayName: "보수 후 이름", categoryPath: [], tagNames: [] },
    });
    vi.mocked(readPageRepair).mockResolvedValue(llmResult(repaired));
    rejectNextVerification();

    const r = await runAnalysis(args);

    expect(readPageRepair).toHaveBeenCalledTimes(1);
    const attempted = vi.mocked(readPageRepair).mock.calls[0][0].attempted;
    expect(attempted.itemSelector).toBe(r.spec?.itemSelector);
    expect(attempted.extractedTitles).toEqual(TITLES.slice(0, 3));
    expect(r.fieldSource).toBe("llm");
    expect(r.suggested.displayName).toBe("보수 후 이름");
    expect(stepOf(r.steps, "AI 재해석")).toMatchObject({ status: "ok" });
  });

  it("보수 후에도 미달이면 휴리스틱 폴백으로 넘어간다", async () => {
    const args = argsFor(TABLE_HTML);
    vi.mocked(readPage).mockResolvedValue(llmResult(goodRead(args.outline)));
    vi.mocked(readPageRepair).mockResolvedValue(llmResult(goodRead(args.outline)));
    rejectNextVerification();
    rejectNextVerification();

    const r = await runAnalysis(args);

    expect(r.fieldSource).toBe("heuristic");
    expect(r.spec?.fieldSource).toBeUndefined();
    const verification = r.steps.filter((s) => s.label === "셀렉터 합성·검증");
    expect(verification.at(-1)).toMatchObject({ status: "warn" });
    expect(verification.at(-1)?.detail).toContain("추출 결과가 AI가 읽은 내용과 달랐습니다 — 패턴 추정으로 진행");
  });

  it("LLM 호출은 분석 1건당 최대 2회다", async () => {
    const args = argsFor(TABLE_HTML);
    vi.mocked(readPage).mockResolvedValue(llmResult(goodRead(args.outline)));
    vi.mocked(readPageRepair).mockResolvedValue(llmResult(goodRead(args.outline)));
    rejectNextVerification();
    rejectNextVerification();

    await runAnalysis(args);

    expect(vi.mocked(readPage).mock.calls.length + vi.mocked(readPageRepair).mock.calls.length).toBe(2);
    expect(recordLlmCall).toHaveBeenCalledTimes(2);
  });

  it("allowRepair=false면 검증 미달에도 보수 호출을 하지 않는다", async () => {
    const args = argsFor(TABLE_HTML, { allowRepair: false });
    vi.mocked(readPage).mockResolvedValue(llmResult(goodRead(args.outline)));
    rejectNextVerification();

    const r = await runAnalysis(args);

    expect(readPageRepair).not.toHaveBeenCalled();
    expect(r.fieldSource).toBe("heuristic");
    expect(recordLlmCall).toHaveBeenCalledTimes(1);
  });

  // 시간 예산: 시도 timeout = clamp((120초 − 경과 − 꼬리 여유 10초) ÷ 2, 15초, 40초). 15초 미만이면 호출하지 않는다.
  describe("시간 예산", () => {
    const SEC = 1000;
    const T0 = Date.parse("2026-11-01T00:00:00.000Z");

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(T0);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    // 분석 시작 후 elapsedMs가 지난 시각으로 시계를 옮기고 그 시작 시각을 돌려준다.
    function startedAgo(elapsedMs: number): number {
      vi.setSystemTime(T0 + elapsedMs);
      return T0;
    }

    it("경과 시간이 짧으면 시도 timeout은 지금과 같은 40초다", async () => {
      const args = argsFor(TABLE_HTML, { startedAt: startedAgo(5 * SEC) });
      vi.mocked(readPage).mockResolvedValue(llmResult(goodRead(args.outline)));

      await runAnalysis(args);

      expect(vi.mocked(readPage).mock.calls[0][0].timeoutMs).toBe(40 * SEC);
    });

    it("렌더링이 오래 걸려 경과 시간이 길면 시도 timeout이 남은 예산에 맞춰 줄어든다", async () => {
      const args = argsFor(TABLE_HTML, { startedAt: startedAgo(60 * SEC) });
      vi.mocked(readPage).mockResolvedValue(llmResult(goodRead(args.outline)));

      await runAnalysis(args);

      // (120 − 60 − 10) ÷ 2 = 25초
      expect(vi.mocked(readPage).mock.calls[0][0].timeoutMs).toBe(25 * SEC);
    });

    it("하한(15초) 경계에서는 호출하고, 그보다 부족하면 호출하지 않는다", async () => {
      const atFloor = argsFor(TABLE_HTML, { startedAt: startedAgo(80 * SEC) });
      vi.mocked(readPage).mockResolvedValue(llmResult(goodRead(atFloor.outline)));
      await runAnalysis(atFloor);
      // (120 − 80 − 10) ÷ 2 = 15초
      expect(vi.mocked(readPage).mock.calls[0][0].timeoutMs).toBe(15 * SEC);

      vi.mocked(readPage).mockClear();
      const belowFloor = argsFor(TABLE_HTML, { startedAt: startedAgo(80 * SEC + 2) });
      await runAnalysis(belowFloor);
      expect(readPage).not.toHaveBeenCalled();
    });

    it("남은 예산이 하한 미만이면 readPage를 호출하지 않고 폴백하며 시간 부족 단계를 남긴다", async () => {
      const args = argsFor(TABLE_HTML, { startedAt: startedAgo(90 * SEC) });

      const r = await runAnalysis(args);

      expect(readPage).not.toHaveBeenCalled();
      expect(recordLlmCall).not.toHaveBeenCalled();
      expect(generateSpec).toHaveBeenCalledTimes(1);
      expect(r.fieldSource).toBe("heuristic");
      expect(stepOf(r.steps, "AI 페이지 해석")).toMatchObject({
        status: "warn",
        detail: "분석 시간이 길어 AI 해석을 건너뛰었습니다 — 패턴 추정으로 진행",
      });
    });

    it("시간 부족 단계는 미설정·한도 초과 단계와 문구가 구분된다", async () => {
      vi.mocked(hasLlm).mockReturnValue(false);
      const notConfigured = await runAnalysis(argsFor(TABLE_HTML, { startedAt: startedAgo(90 * SEC) }));

      // 미설정이 먼저 가려진다: 시간이 없어도 "시간이 길어"라고 말하지 않는다.
      expect(stepOf(notConfigured.steps, "AI 페이지 해석")?.detail).toContain("설정되지 않았습니다");
      expect(stepOf(notConfigured.steps, "AI 페이지 해석")?.detail).not.toContain("시간이 길어");
    });

    it("보수 호출도 첫 호출이 끝난 시점의 남은 예산으로 시도 timeout을 정한다", async () => {
      const args = argsFor(TABLE_HTML, { startedAt: startedAgo(0) });
      // 첫 호출이 50초 걸렸다고 치고 시계를 옮긴다.
      vi.mocked(readPage).mockImplementation(async () => {
        vi.setSystemTime(T0 + 50 * SEC);
        return llmResult(goodRead(args.outline));
      });
      vi.mocked(readPageRepair).mockResolvedValue(llmResult(goodRead(args.outline)));
      rejectNextVerification();

      await runAnalysis(args);

      expect(vi.mocked(readPage).mock.calls[0][0].timeoutMs).toBe(40 * SEC);
      // (120 − 50 − 10) ÷ 2 = 30초
      expect(vi.mocked(readPageRepair).mock.calls[0][0].timeoutMs).toBe(30 * SEC);
    });

    it("첫 호출이 오래 걸려 남은 예산이 하한 미만이면 보수를 건너뛰고 그 사실을 단계에 남긴다", async () => {
      const args = argsFor(TABLE_HTML, { startedAt: startedAgo(0) });
      vi.mocked(readPage).mockImplementation(async () => {
        vi.setSystemTime(T0 + 85 * SEC);
        return llmResult(goodRead(args.outline));
      });
      rejectNextVerification();

      const r = await runAnalysis(args);

      expect(readPageRepair).not.toHaveBeenCalled();
      expect(r.fieldSource).toBe("heuristic");
      expect(stepOf(r.steps, "AI 재해석")).toMatchObject({ status: "warn" });
      expect(stepOf(r.steps, "AI 재해석")?.detail).toContain("시간이 길어");
    });

    it("시간 초과로 보수를 건너뛸 때 \"한 번 더 읽습니다\"라는 단계를 남기지 않는다", async () => {
      const args = argsFor(TABLE_HTML, { startedAt: startedAgo(0) });
      vi.mocked(readPage).mockImplementation(async () => {
        vi.setSystemTime(T0 + 85 * SEC);
        return llmResult(goodRead(args.outline));
      });
      rejectNextVerification();

      const r = await runAnalysis(args);

      const verification = stepOf(r.steps, "셀렉터 합성·검증");
      expect(verification?.detail).not.toContain("한 번 더 읽습니다");
      expect(verification?.detail).toContain("패턴 추정으로 진행");
      expect(r.steps.some((s) => s.detail?.includes("한 번 더 읽습니다"))).toBe(false);
    });
  });

  it("보수가 가능한 경로의 첫 단계 문구는 \"한 번 더 읽습니다\"다", async () => {
    const args = argsFor(TABLE_HTML);
    vi.mocked(readPage).mockResolvedValue(llmResult(goodRead(args.outline)));
    vi.mocked(readPageRepair).mockResolvedValue(llmResult(goodRead(args.outline)));
    rejectNextVerification();

    const r = await runAnalysis(args);

    const verification = r.steps.filter((s) => s.label === "셀렉터 합성·검증");
    expect(verification[0]).toMatchObject({ status: "warn" });
    expect(verification[0].detail).toContain("한 번 더 읽습니다");
  });

  it("개요가 비어 있으면 LLM을 호출하지 않고 한도도 확인하지 않으며 상세 판정과 구분되는 단계를 남긴다", async () => {
    const args = argsFor("<html><body></body></html>");
    expect(args.outline.text).toBe("");

    const r = await runAnalysis(args);

    expect(readPage).not.toHaveBeenCalled();
    expect(checkLlmQuota).not.toHaveBeenCalled();
    expect(recordLlmCall).not.toHaveBeenCalled();
    expect(stepOf(r.steps, "AI 페이지 해석")).toMatchObject({
      status: "warn",
      detail: "페이지에서 읽을 내용을 찾지 못했습니다 — 패턴 추정으로 진행",
    });
    expect(r.steps.some((s) => s.detail?.includes("상세 페이지로 판단"))).toBe(false);
    expect(generateSpec).toHaveBeenCalledTimes(1);
  });

  it("응답의 suggested 배열은 호출마다 새로 만들어진다", async () => {
    vi.mocked(hasLlm).mockReturnValue(false);
    const first = await runAnalysis(argsFor(TABLE_HTML));
    first.suggested.categoryPath.push("오염");
    first.suggested.tagNames.push("오염");

    const second = await runAnalysis(argsFor(TABLE_HTML));

    expect(second.suggested).toEqual({ displayName: "", categoryPath: [], tagNames: [] });
  });

  it("합성이 null이면 보수 없이 폴백하고 단계에 합성 실패를 적는다", async () => {
    const args = argsFor(TABLE_HTML);
    // 개요에 없는 번호만 보고하면 해소된 제목이 2개 미만이라 합성이 null이다.
    const unresolvable = goodRead(args.outline, {
      items: [
        { titleRef: 9998, titleText: "없는 제목 하나", fields: [] },
        { titleRef: 9999, titleText: "없는 제목 둘", fields: [] },
      ],
    });
    vi.mocked(readPage).mockResolvedValue(llmResult(unresolvable));

    const r = await runAnalysis(args);

    expect(stepOf(r.steps, "셀렉터 합성")).toMatchObject({
      status: "warn",
      detail: "AI가 읽은 항목을 셀렉터로 옮길 수 없었습니다 — 패턴 추정으로 진행",
    });
    expect(readPageRepair).not.toHaveBeenCalled();
    expect(r.fieldSource).toBe("heuristic");
  });

  it("LLM이 제안한 표시 이름·카테고리 경로·태그를 suggested로 돌려준다", async () => {
    const args = argsFor(TABLE_HTML);
    vi.mocked(readPage).mockResolvedValue(
      llmResult(
        goodRead(args.outline, {
          suggested: { displayName: " 진흥원 공고 ", categoryPath: ["지원사업", " "], tagNames: ["공고"] },
        }),
      ),
    );

    const r = await runAnalysis(args);

    expect(r.suggested).toEqual({ displayName: "진흥원 공고", categoryPath: ["지원사업"], tagNames: ["공고"] });
    expect(r.pageTitle).toBe("사업공고 (AI가 읽은 제목)");
  });

  it("개요가 잘렸으면 그 사실을 개요 텍스트 끝에 붙여 모델에 알린다", async () => {
    const outline = { ...buildPageOutline(TABLE_HTML), truncated: true };
    const args = { ...argsFor(TABLE_HTML), outline };
    vi.mocked(readPage).mockResolvedValue(llmResult(goodRead(outline)));

    await runAnalysis(args);

    const sent = vi.mocked(readPage).mock.calls[0][0].outlineText;
    expect(sent.startsWith(outline.text)).toBe(true);
    expect(sent).toContain("잘렸습니다");
  });

  it("개요가 잘리지 않았으면 개요 텍스트를 그대로 보낸다", async () => {
    const args = argsFor(TABLE_HTML);
    vi.mocked(readPage).mockResolvedValue(llmResult(goodRead(args.outline)));

    await runAnalysis(args);

    expect(vi.mocked(readPage).mock.calls[0][0].outlineText).toBe(args.outline.text);
  });
});

describe("runAnalysis — LLM을 쓸 수 없을 때", () => {
  it("hasLlm이 false면 LLM을 호출하지 않고 폴백 단계를 남긴다", async () => {
    vi.mocked(hasLlm).mockReturnValue(false);

    const r = await runAnalysis(argsFor(TABLE_HTML));

    expect(readPage).not.toHaveBeenCalled();
    expect(checkLlmQuota).not.toHaveBeenCalled();
    expect(stepOf(r.steps, "AI 페이지 해석")).toMatchObject({
      status: "warn",
      detail: "AI 분석이 설정되지 않았습니다 — 패턴 추정으로 진행",
    });
    expect(r.fieldSource).toBe("heuristic");
    expect(r.rows.length).toBeGreaterThanOrEqual(3);
  });

  it("한도 초과면 폴백하고 단계 detail에 한도 초과를 적는다", async () => {
    vi.mocked(checkLlmQuota).mockResolvedValue(false);

    const r = await runAnalysis(argsFor(TABLE_HTML));

    expect(readPage).not.toHaveBeenCalled();
    expect(stepOf(r.steps, "AI 페이지 해석")).toMatchObject({
      status: "warn",
      detail: "일별 AI 분석 한도를 초과했습니다 — 패턴 추정으로 진행",
    });
    expect(r.fieldSource).toBe("heuristic");
  });

  it("한도 확인 자체가 예외를 던져도 호출하지 않고 폴백한다", async () => {
    vi.mocked(checkLlmQuota).mockRejectedValue(new Error("db down"));

    const r = await runAnalysis(argsFor(TABLE_HTML));

    expect(readPage).not.toHaveBeenCalled();
    expect(r.fieldSource).toBe("heuristic");
  });

  it.each(["http", "timeout", "schema"] as const)("LlmError(%s)가 나도 예외를 던지지 않고 폴백한다", async (kind) => {
    vi.mocked(readPage).mockRejectedValue(new LlmError("upstream 502 sk-live-SECRET Bearer abc", kind));

    const r = await runAnalysis(argsFor(TABLE_HTML));

    expect(r.fieldSource).toBe("heuristic");
    expect(stepOf(r.steps, "AI 페이지 해석")).toMatchObject({
      status: "warn",
      detail: "AI 분석 호출에 실패했습니다 — 패턴 추정으로 진행",
    });
  });

  it("LlmError가 아닌 예외가 나도 폴백한다", async () => {
    vi.mocked(readPage).mockRejectedValue(new TypeError("fetch failed"));

    const r = await runAnalysis(argsFor(TABLE_HTML));

    expect(r.fieldSource).toBe("heuristic");
  });

  it("단계 detail에 프로바이더 원문 오류 메시지를 넣지 않는다", async () => {
    vi.mocked(readPage).mockRejectedValue(new LlmError("upstream 502 sk-live-SECRET Bearer abc", "http"));

    const r = await runAnalysis(argsFor(TABLE_HTML));

    const text = JSON.stringify(r.steps);
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("502");
    expect(text).not.toContain("Bearer");
  });

  it("보수 호출이 실패하면 단계에 남기고 폴백한다", async () => {
    const args = argsFor(TABLE_HTML);
    vi.mocked(readPage).mockResolvedValue(llmResult(goodRead(args.outline)));
    vi.mocked(readPageRepair).mockRejectedValue(new LlmError("secret detail", "timeout"));
    rejectNextVerification();

    const r = await runAnalysis(args);

    expect(r.fieldSource).toBe("heuristic");
    expect(stepOf(r.steps, "AI 재해석")).toMatchObject({
      status: "warn",
      detail: "AI 분석 호출에 실패했습니다 — 패턴 추정으로 진행",
    });
    expect(JSON.stringify(r.steps)).not.toContain("secret detail");
  });

  it("휴리스틱이 실패해도 JSON-LD 목록이 있으면 structured로 돌려준다", async () => {
    vi.mocked(hasLlm).mockReturnValue(false);
    const ld = {
      "@context": "https://schema.org",
      "@type": "ItemList",
      itemListElement: [1, 2, 3].map((i) => ({
        "@type": "ListItem",
        item: { name: `항목 ${i}`, url: `/n/${i}`, datePublished: "2025-09-15" },
      })),
    };
    const html = `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body><p>본문</p></body></html>`;

    const r = await runAnalysis(argsFor(html));

    expect(r.strategy).toBe("structured");
    expect(r.spec).toEqual({ strategy: "structured" });
    expect(r.rows).toHaveLength(3);
    expect(r.fieldSource).toBe("heuristic");
  });
});

const DETAIL_HTML = `<html><body>
  <header><a href="/notice">사업공고</a><a href="/news">알림마당</a></header>
  <div id="content"><h1>2026년 AI 바우처 지원사업 공고</h1><p>본문입니다.</p></div>
</body></html>`;

describe("runAnalysis — 상세 페이지와 부모 후보", () => {
  const detailRead = (candidates: { label: string; url: string }[]): PageReadResult => ({
    pageKind: "detail",
    pageTitle: "공고 상세",
    items: [],
    listCandidates: candidates,
    suggested: { displayName: "", categoryPath: [], tagNames: [] },
  });

  it("pageKind=detail이면 listCandidates를 페이지 앵커로 검증해 돌려준다", async () => {
    const args = argsFor(DETAIL_HTML);
    vi.mocked(readPage).mockResolvedValue(
      llmResult(detailRead([{ label: "사업공고", url: "/notice" }])),
    );

    const r = await runAnalysis(args);

    expect(r.spec).toBeNull();
    expect(r.pageKind).toBe("detail");
    expect(r.listCandidates).toEqual([{ label: "사업공고", url: "https://www.example.kr/notice" }]);
    // LLM이 목록이 없다고 판단한 곳에서 패턴 추정을 다시 돌리지 않는다.
    expect(r.steps.some((s) => s.label === "HTML 목록 패턴 추출")).toBe(false);
    expect(readPageRepair).not.toHaveBeenCalled();
  });

  it("listCandidates의 URL이 페이지에 없는 앵커면 버린다", async () => {
    const args = argsFor(DETAIL_HTML);
    vi.mocked(readPage).mockResolvedValue(
      llmResult(
        detailRead([
          { label: "지어낸 목록", url: "/made/up/list" },
          { label: "외부", url: "https://evil.example/list" },
          { label: "알림마당", url: "/news" },
          { label: "알림마당 중복", url: "https://www.example.kr/news" },
        ]),
      ),
    );

    const r = await runAnalysis(args);

    expect(r.listCandidates).toEqual([{ label: "알림마당", url: "https://www.example.kr/news" }]);
  });

  it("pageKind=detail인데 items가 비면 LLM을 믿고 휴리스틱 폴백을 돌리지 않는다", async () => {
    const args = argsFor(TABLE_HTML);
    vi.mocked(readPage).mockResolvedValue(llmResult(detailRead([])));

    const r = await runAnalysis(args);

    expect(generateSpec).not.toHaveBeenCalled();
    expect(r.spec).toBeNull();
    expect(r.fieldSource).toBeNull();
    expect(stepOf(r.steps, "AI 페이지 해석")).toMatchObject({ status: "ok" });
    expect(stepOf(r.steps, "AI 페이지 해석")?.detail).toContain("상세 페이지로 판단");
  });

  it("pageKind=unknown인데 items가 비어도 폴백을 돌리지 않는다", async () => {
    const args = argsFor(TABLE_HTML);
    vi.mocked(readPage).mockResolvedValue(llmResult({ ...detailRead([]), pageKind: "unknown" }));

    const r = await runAnalysis(args);

    expect(generateSpec).not.toHaveBeenCalled();
    expect(r.spec).toBeNull();
  });

  it("pageKind=list인데 items가 비면 모순된 응답이라 휴리스틱 폴백을 돌린다", async () => {
    const args = argsFor(TABLE_HTML);
    vi.mocked(readPage).mockResolvedValue(llmResult({ ...detailRead([]), pageKind: "list" }));

    const r = await runAnalysis(args);

    expect(generateSpec).toHaveBeenCalledTimes(1);
    expect(r.fieldSource).toBe("heuristic");
    expect(r.rows.length).toBeGreaterThanOrEqual(3);
    expect(r.pageKind).toBe("list");
    // 보수 호출 대상이 아니다: 검증할 스펙이 없다.
    expect(readPageRepair).not.toHaveBeenCalled();
    const read = stepOf(r.steps, "AI 페이지 해석");
    expect(read?.status).toBe("warn");
    expect(read?.detail).toContain("항목을 하나도 짚지 못했습니다");
    expect(read?.detail).not.toContain("상세 페이지로 판단");
  });

  it("목록이 있는 페이지에서는 listCandidates를 돌려주지 않는다", async () => {
    const args = argsFor(TABLE_HTML);
    vi.mocked(readPage).mockResolvedValue(
      llmResult(goodRead(args.outline, { listCandidates: [{ label: "사업공고", url: "/notice" }] })),
    );

    const r = await runAnalysis(args);

    expect(r.spec).not.toBeNull();
    expect(r.listCandidates).toEqual([]);
  });
});

describe("runAnalysis — 힌트", () => {
  it("힌트가 개요에 없으면 warn 단계를 남기되 분석은 계속한다", async () => {
    const args = argsFor(TABLE_HTML, { hint: "존재하지 않는 공고 제목" });
    vi.mocked(readPage).mockResolvedValue(llmResult(goodRead(args.outline)));

    const r = await runAnalysis(args);

    expect(stepOf(r.steps, "힌트 확인")).toMatchObject({
      status: "warn",
      detail: "힌트 문자열이 현재 페이지에 없습니다 — 목록 내용이 바뀐 것 같습니다",
    });
    expect(r.fieldSource).toBe("llm");
  });

  it("힌트가 개요에 있으면 단계를 남기지 않고, 스펙에 hint와 hintSetAt을 남긴다", async () => {
    const args = argsFor(TABLE_HTML, { hint: "AI 바우처" });
    vi.mocked(readPage).mockResolvedValue(llmResult(goodRead(args.outline)));
    const before = Date.now();

    const r = await runAnalysis(args);

    expect(stepOf(r.steps, "힌트 확인")).toBeUndefined();
    expect(r.spec?.hint).toBe("AI 바우처");
    const setAt = Date.parse(r.spec?.hintSetAt ?? "");
    expect(setAt).toBeGreaterThanOrEqual(before);
    expect(setAt).toBeLessThanOrEqual(Date.now());
    expect(vi.mocked(readPage).mock.calls[0][0].hint).toBe("AI 바우처");
  });

  it("호출자가 넘긴 hintSetAt을 그대로 보존한다", async () => {
    const stored = "2026-01-12T00:00:00.000Z";
    const args = argsFor(TABLE_HTML, { hint: "AI 바우처", hintSetAt: stored });
    vi.mocked(readPage).mockResolvedValue(llmResult(goodRead(args.outline)));

    const r = await runAnalysis(args);

    expect(r.spec?.hintSetAt).toBe(stored);
  });

  it("힌트가 없으면 스펙에 hint를 남기지 않는다", async () => {
    const args = argsFor(TABLE_HTML);
    vi.mocked(readPage).mockResolvedValue(llmResult(goodRead(args.outline)));

    const r = await runAnalysis(args);

    expect(r.spec?.hint).toBeUndefined();
    expect(r.spec?.hintSetAt).toBeUndefined();
  });

  it("폴백 경로의 스펙에도 hint와 hintSetAt을 남긴다", async () => {
    vi.mocked(hasLlm).mockReturnValue(false);

    const r = await runAnalysis(argsFor(TABLE_HTML, { hint: "AI 바우처" }));

    expect(r.spec?.hint).toBe("AI 바우처");
    expect(r.spec?.hintSetAt).toBeTruthy();
  });
});

describe("runAnalysis — 호출 이력", () => {
  it("성공한 호출을 토큰·소요 시간과 함께 기록한다", async () => {
    const args = argsFor(TABLE_HTML, { userId: "u9", sourceId: "s3", purpose: "rebuild" });
    vi.mocked(readPage).mockResolvedValue(llmResult(goodRead(args.outline)));

    await runAnalysis(args);

    expect(recordLlmCall).toHaveBeenCalledTimes(1);
    expect(recordLlmCall).toHaveBeenCalledWith({
      userId: "u9",
      sourceId: "s3",
      purpose: "rebuild",
      model: "test-model",
      promptTokens: 100,
      completionTokens: 50,
      durationMs: 1234,
      ok: true,
      errorCode: null,
    });
  });

  it("실패한 호출도 오류 종류와 함께 기록한다", async () => {
    vi.mocked(readPage).mockRejectedValue(new LlmError("provider raw message", "timeout"));

    await runAnalysis(argsFor(TABLE_HTML));

    expect(recordLlmCall).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordLlmCall).mock.calls[0][0]).toMatchObject({
      ok: false,
      errorCode: "timeout",
      promptTokens: null,
      completionTokens: null,
    });
    // 이력의 errorCode에도 프로바이더 원문은 들어가지 않는다.
    expect(JSON.stringify(vi.mocked(recordLlmCall).mock.calls[0][0])).not.toContain("provider raw message");
  });

  it("호출이 발생하지 않으면 기록하지 않는다", async () => {
    vi.mocked(hasLlm).mockReturnValue(false);

    await runAnalysis(argsFor(TABLE_HTML));

    expect(recordLlmCall).not.toHaveBeenCalled();
  });

  it("기록 실패가 분석 결과를 바꾸지 않는다", async () => {
    const args = argsFor(TABLE_HTML);
    vi.mocked(readPage).mockResolvedValue(llmResult(goodRead(args.outline)));
    vi.mocked(recordLlmCall).mockRejectedValue(new Error("db down"));

    const r = await runAnalysis(args);

    expect(r.fieldSource).toBe("llm");
    expect(r.rows).toHaveLength(4);
  });

  it("호출 실패 기록이 실패해도 폴백으로 간다", async () => {
    vi.mocked(readPage).mockRejectedValue(new LlmError("x", "http"));
    vi.mocked(recordLlmCall).mockRejectedValue(new Error("db down"));

    const r = await runAnalysis(argsFor(TABLE_HTML));

    expect(r.fieldSource).toBe("heuristic");
  });
});

describe("runAnalysis — 진단 정보 노출", () => {
  it("개요가 잘렸으면 AI 해석 단계 detail에 그 사실을 적는다", async () => {
    const args = argsFor(TABLE_HTML);
    const outline = { ...args.outline, truncated: true };
    vi.mocked(readPage).mockResolvedValue(llmResult(goodRead(outline)));

    const r = await runAnalysis({ ...args, outline });

    expect(stepOf(r.steps, "AI 페이지 해석")?.detail).toContain("개요 일부가 잘림");
  });

  it("개요가 잘리지 않았으면 detail에 잘림 문구가 없다", async () => {
    const args = argsFor(TABLE_HTML);
    vi.mocked(readPage).mockResolvedValue(llmResult(goodRead(args.outline)));

    const r = await runAnalysis(args);

    expect(stepOf(r.steps, "AI 페이지 해석")?.detail).not.toContain("잘림");
  });

  it("합성이 필드를 버리면 검증 단계 detail에 개수를 적고 로그에는 key와 사유만 남긴다", async () => {
    const args = argsFor(TABLE_HTML);
    const base = goodRead(args.outline);
    // key "title"은 고정 컬럼 이름이라 합성이 버린다.
    const read = {
      ...base,
      items: base.items.map((item, i) => ({
        ...item,
        fields: [
          ...item.fields,
          { key: "title", label: "제목", type: "text" as const, role: "none" as const, ref: refOf(args.outline, ORGS[i]), text: ORGS[i] },
        ],
      })),
    };
    vi.mocked(readPage).mockResolvedValue(llmResult(read));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const r = await runAnalysis(args);

    expect(stepOf(r.steps, "셀렉터 합성·검증")?.detail).toContain("합성 중 제외 1건");
    const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes("셀렉터 합성"));
    expect(line).toContain("remapped=0");
    expect(line).toContain("dropped=1");
    expect(line).toContain("title:");
    // 페이지에서 온 값(제목·기관명)은 로그에 싣지 않는다.
    for (const text of [...TITLES, ...ORGS]) expect(line).not.toContain(text);
  });

  it("버린 것이 없으면 detail에 제외 문구가 없다", async () => {
    const args = argsFor(TABLE_HTML);
    vi.mocked(readPage).mockResolvedValue(llmResult(goodRead(args.outline)));

    const r = await runAnalysis(args);

    expect(stepOf(r.steps, "셀렉터 합성·검증")?.detail).not.toContain("제외");
  });
});

describe("runAnalysis — 순수 파싱이 던질 때", () => {
  it("폴백의 generateSpec이 던지면 예외 대신 warn 단계와 빈 결과를 돌려준다", async () => {
    vi.mocked(hasLlm).mockReturnValue(false);
    vi.mocked(generateSpec).mockImplementationOnce(() => {
      throw new Error("parser boom");
    });

    const r = await runAnalysis(argsFor(TABLE_HTML));

    expect(r.spec).toBeNull();
    expect(r.fieldSource).toBeNull();
    expect(stepOf(r.steps, "HTML 목록 패턴 추출")).toMatchObject({ status: "warn" });
    expect(JSON.stringify(r.steps)).not.toContain("parser boom");
  });
});
