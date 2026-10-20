import { analyzeResultSchema } from "@myportal/api-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError, errorCodes } from "../../errors/error-codes";
import { analyzeUrl } from "./analyze";
import type { CrawlSpec, ExtractedRow } from "./extract";
import { enrichWithLlm, type EnrichResult } from "./llm/enrich";
import { fetchPage } from "./fetcher";
import { renderPage } from "./render";
import { robotsAllowed } from "./robots";

const dbQuery = vi.fn();
vi.mock("../../config/db", () => ({ getDb: () => ({ query: dbQuery }) }));
vi.mock("./fetcher", () => ({ fetchPage: vi.fn() }));
vi.mock("./render", () => ({ renderPage: vi.fn() }));
vi.mock("./robots", () => ({ robotsAllowed: vi.fn() }));
vi.mock("./llm/enrich", () => ({ enrichWithLlm: vi.fn() }));

const URL_IN = "https://x.kr/list";

// 휴리스틱(generateSpec)이 본문 목록으로 잡는 게시판 픽스처.
const LIST_HTML = `<html><head><title>공고 목록</title></head><body>
  <div class="content"><ul class="list">
    ${[1, 2, 3, 4, 5]
      .map(
        (i) => `<li><div class="tit"><a href="/v/${i}">제${i}회 전국 아이디어 공모전 모집 안내</a></div>
          <span class="org">기관${i}</span></li>`,
      )
      .join("")}
  </ul></div>
</body></html>`;

// 반복 목록이 전혀 없는 페이지 — 휴리스틱이 실패해 구제 경로로 간다.
const EMPTY_HTML = `<html><head><title>상세</title></head><body><p>본문입니다</p></body></html>`;
const RENDERED_HTML = `<html><head><title>렌더링됨</title></head><body><div id="app">렌더링 후 DOM</div></body></html>`;
const RENDERED_URL = "https://x.kr/list?rendered=1";

function page(body: string) {
  return {
    finalUrl: URL_IN,
    status: 200,
    contentType: "text/html",
    body,
    etag: null,
    lastModified: null,
  };
}

function makeRows(n: number): ExtractedRow[] {
  return Array.from({ length: n }, (_, i) => ({
    title: `제목${i}`,
    link: `https://x.kr/v/${i}`,
    publishedAt: null,
    attrs: { org: `기관${i}` },
  }));
}

function enrichOk(
  spec: CrawlSpec,
  rows: ExtractedRow[],
  detail = "필드 1개 추론",
): EnrichResult {
  return {
    spec,
    rows,
    fieldSource: "llm",
    step: { label: "AI 필드 분석", status: "ok", detail },
  };
}

const rescueSpec = (): CrawlSpec => ({
  strategy: "html",
  itemSelector: "div.card",
  fields: {},
});

beforeEach(() => {
  vi.resetAllMocks();
  dbQuery.mockResolvedValue({ rows: [] });
  vi.mocked(robotsAllowed).mockResolvedValue(true);
  vi.mocked(fetchPage).mockResolvedValue(page(LIST_HTML));
  vi.mocked(renderPage).mockRejectedValue(new Error("no browser"));
  // 기본: LLM 미설정과 같이 휴리스틱 결과를 그대로 돌려준다.
  vi.mocked(enrichWithLlm).mockImplementation(async (args) =>
    args.base
      ? {
          ...args.base,
          fieldSource: "heuristic",
          step: { label: "AI 필드 분석", status: "warn", detail: "건너뜀" },
        }
      : null,
  );
});

describe("analyzeUrl", () => {
  it("모든 outcome의 반환값이 analyzeResultSchema를 통과한다", async () => {
    const outcomes = new Set<string>();
    const check = (r: Awaited<ReturnType<typeof analyzeUrl>>) => {
      expect(() => analyzeResultSchema.parse(r)).not.toThrow();
      outcomes.add(r.outcome);
    };

    // error: 사설 주소는 URL 검증에서 막힌다
    check(await analyzeUrl("u1", "http://localhost/x"));

    // exists
    dbQuery.mockResolvedValueOnce({ rows: [{ id: "src-1" }] });
    check(await analyzeUrl("u1", URL_IN));

    // link-only
    vi.mocked(robotsAllowed).mockResolvedValueOnce(false);
    check(await analyzeUrl("u1", URL_IN));

    // detail
    vi.mocked(fetchPage).mockResolvedValueOnce(page(EMPTY_HTML));
    check(await analyzeUrl("u1", URL_IN));

    // list
    check(await analyzeUrl("u1", URL_IN));

    expect([...outcomes].sort()).toEqual(
      ["detail", "error", "exists", "link-only", "list"].sort(),
    );
  });

  it("목록 분석 성공 시 enrich 결과의 fieldSource를 응답에 담는다", async () => {
    vi.mocked(enrichWithLlm).mockImplementation(async (args) =>
      enrichOk(args.base!.spec, args.base!.rows),
    );
    const r = await analyzeUrl("u1", URL_IN);
    expect(r.outcome).toBe("list");
    expect(r.fieldSource).toBe("llm");
    expect(() => analyzeResultSchema.parse(r)).not.toThrow();
  });

  it("enrich가 돌려준 단계가 steps에 붙고 userId·purpose가 전달된다", async () => {
    vi.mocked(enrichWithLlm).mockImplementation(async (args) =>
      enrichOk(args.base!.spec, args.base!.rows),
    );
    const r = await analyzeUrl("user-7", URL_IN);
    expect(r.steps.some((s) => s.label === "AI 필드 분석")).toBe(true);
    const call = vi.mocked(enrichWithLlm).mock.calls[0][0];
    expect(call.userId).toBe("user-7");
    expect(call.sourceId).toBeNull();
    expect(call.purpose).toBe("analyze-fields");
    expect(call.pageUrl).toBe(URL_IN);
  });

  it("preview.fields는 enrich된 스펙의 메타를 반영한다", async () => {
    vi.mocked(enrichWithLlm).mockImplementation(async (args) =>
      enrichOk(
        {
          ...args.base!.spec,
          fields: {
            org: {
              selector: ".org",
              label: "주최기관",
              type: "text",
              role: "none",
            },
          },
        },
        makeRows(5),
      ),
    );
    const r = await analyzeUrl("u1", URL_IN);
    const org = r.preview!.fields.find((f) => f.key === "org");
    expect(org?.label).toBe("주최기관");
  });

  it("목록을 못 찾았고 구제도 실패하면 detail로 끝난다", async () => {
    vi.mocked(fetchPage).mockResolvedValue(page(EMPTY_HTML));
    const r = await analyzeUrl("u1", URL_IN);
    expect(enrichWithLlm).toHaveBeenCalledTimes(1);
    const call = vi.mocked(enrichWithLlm).mock.calls[0][0];
    expect(call.base).toBeNull();
    expect(call.purpose).toBe("analyze-rescue");
    expect(r.outcome).toBe("detail");
    expect(r.fieldSource).toBeNull();
    expect(r.steps.some((s) => s.label === "AI 필드 분석")).toBe(false);
  });

  it("목록을 못 찾았지만 구제가 성공하면 list로 전환된다", async () => {
    vi.mocked(fetchPage).mockResolvedValue(page(EMPTY_HTML));
    vi.mocked(enrichWithLlm).mockResolvedValue(
      enrichOk(
        rescueSpec(),
        makeRows(24),
        "AI가 목록 패턴을 찾았습니다 (24개 항목)",
      ),
    );
    const r = await analyzeUrl("u1", URL_IN);
    expect(r.outcome).toBe("list");
    expect(r.preview?.fetchStrategy).toBe("html");
    expect(r.preview?.rows).toHaveLength(10);
    expect(r.fieldSource).toBe("llm");
    expect(() => analyzeResultSchema.parse(r)).not.toThrow();
  });

  describe("렌더링·힌트 전파", () => {
    beforeEach(() => {
      vi.mocked(fetchPage).mockResolvedValue(page(EMPTY_HTML));
      vi.mocked(renderPage).mockResolvedValue({
        finalUrl: RENDERED_URL,
        html: RENDERED_HTML,
      });
    });

    it("렌더링된 HTML로 구제가 성공하면 스펙에 render=true가 설정된다", async () => {
      vi.mocked(enrichWithLlm).mockResolvedValue(
        enrichOk(rescueSpec(), makeRows(24)),
      );
      const r = await analyzeUrl("u1", URL_IN);
      // 구제는 렌더링된 DOM 기준으로 호출돼야 한다.
      const call = vi.mocked(enrichWithLlm).mock.calls[0][0];
      expect(call.html).toBe(RENDERED_HTML);
      expect(call.pageUrl).toBe(RENDERED_URL);
      expect((r.preview?.spec as CrawlSpec).render).toBe(true);
    });

    it("정적 HTML로 구제가 성공하면 render를 설정하지 않는다", async () => {
      vi.mocked(renderPage).mockRejectedValue(new Error("no browser"));
      vi.mocked(enrichWithLlm).mockResolvedValue(
        enrichOk(rescueSpec(), makeRows(24)),
      );
      const r = await analyzeUrl("u1", URL_IN);
      const call = vi.mocked(enrichWithLlm).mock.calls[0][0];
      expect(call.html).toBe(EMPTY_HTML);
      expect((r.preview?.spec as CrawlSpec).render).toBeUndefined();
    });

    it("사용자 힌트는 구제로 만들어진 스펙에도 유지된다", async () => {
      vi.mocked(enrichWithLlm).mockResolvedValue(
        enrichOk(rescueSpec(), makeRows(24)),
      );
      const r = await analyzeUrl("u1", URL_IN, "공고 2번");
      expect((r.preview?.spec as CrawlSpec).hint).toBe("공고 2번");
    });
  });

  it("RSS 소스는 enrich가 건너뛰어도 전략이 rss로 유지된다", async () => {
    const rss = `<?xml version="1.0"?><rss version="2.0"><channel>${[1, 2, 3]
      .map((i) => `<item><title>공고 ${i}</title><link>/n/${i}</link></item>`)
      .join("")}</channel></rss>`;
    vi.mocked(fetchPage).mockResolvedValue({
      ...page(rss),
      contentType: "application/rss+xml",
    });
    const r = await analyzeUrl("u1", URL_IN);
    expect(r.outcome).toBe("list");
    expect(r.preview?.fetchStrategy).toBe("rss");
    expect((r.preview?.spec as CrawlSpec).strategy).toBe("rss");
    expect(r.fieldSource).toBe("heuristic");
  });

  it("렌더링 실패가 AppError여도 구제는 정적 HTML로 계속된다", async () => {
    vi.mocked(fetchPage).mockResolvedValue(page(EMPTY_HTML));
    vi.mocked(renderPage).mockRejectedValue(
      new AppError(errorCodes.EXTRACTION_FAILED, "브라우저 없음", 500),
    );
    const r = await analyzeUrl("u1", URL_IN);
    expect(r.outcome).toBe("detail");
    expect(enrichWithLlm).toHaveBeenCalledTimes(1);
  });
});
