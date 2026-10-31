import { analyzeResultSchema } from "@myportal/api-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hasLlm } from "../../config/env";
import { AppError, errorCodes } from "../../errors/error-codes";
import { analyzeListing, analyzeUrl } from "./analyze";
import { readPage, readPageRepair, type PageReadResult } from "./analyze/llm-read";
import { buildPageOutline } from "./analyze/page-outline";
import { fetchProfileSchema } from "./analyze/profile";
import type { CrawlSpec } from "./extract";
import { fetchPage } from "./fetcher";
import { checkLlmQuota, recordLlmCall } from "./llm/usage";
import { renderPage } from "./render";
import { robotsAllowed } from "./robots";

const dbQuery = vi.fn();
vi.mock("../../config/db", () => ({ getDb: () => ({ query: dbQuery }) }));
vi.mock("../../config/env", () => ({
  env: { llmApiBase: "https://llm.test/v1", llmApiKey: "test-key", llmModel: "test-model" },
  hasLlm: vi.fn(),
}));
vi.mock("./fetcher", () => ({ fetchPage: vi.fn() }));
vi.mock("./render", () => ({ renderPage: vi.fn() }));
vi.mock("./robots", () => ({ robotsAllowed: vi.fn() }));
vi.mock("./llm/usage", () => ({ checkLlmQuota: vi.fn(), recordLlmCall: vi.fn() }));
vi.mock("./analyze/llm-read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./analyze/llm-read")>()),
  readPage: vi.fn(),
  readPageRepair: vi.fn(),
}));

const URL_IN = "https://x.kr/list";
const RENDERED_URL = "https://x.kr/list?rendered=1";
const TITLE_COUNT = 5;

const titleOf = (i: number) => `제${i}회 전국 아이디어 공모전 모집 안내`;
const orgOf = (i: number) => `기관${i}`;

// 본문 목록이 있는 게시판 픽스처.
const LIST_HTML = `<html><head><title>공고 목록</title></head><body>
  <div class="content"><ul class="list">
    ${Array.from({ length: TITLE_COUNT }, (_, k) => k + 1)
      .map(
        (i) => `<li><div class="tit"><a href="/v/${i}">${titleOf(i)}</a></div>
          <span class="org">${orgOf(i)}</span></li>`,
      )
      .join("")}
  </ul></div>
</body></html>`;

// 반복 목록이 전혀 없는 페이지 — 상세 페이지다. 헤더 링크는 부모 목록 후보의 재료가 된다.
const DETAIL_HTML = `<html><head><title>상세</title></head><body>
  <header><a href="/board">공고 게시판</a></header><p>본문입니다</p></body></html>`;

function page(body: string, patch: Record<string, unknown> = {}) {
  return {
    finalUrl: URL_IN,
    status: 200,
    contentType: "text/html",
    body,
    etag: null,
    lastModified: null,
    ...patch,
  };
}

const READY_TIMINGS = { readyMs: 2400, readyBy: "stabilized", grewByScroll: false } as const;

function rendered(html: string, finalUrl = URL_IN) {
  return { finalUrl, html, timings: READY_TIMINGS };
}

function refOf(html: string, text: string): number {
  const outline = buildPageOutline(html);
  const ref = outline.refs.findIndex(
    (el) => el !== null && (el.textContent ?? "").replace(/\s+/g, " ").trim() === text,
  );
  if (ref < 0) throw new Error(`개요에 "${text}"가 없다`);
  return ref;
}

// 개요는 분석이 렌더된 HTML로 만들므로 같은 HTML로 번호를 찾으면 일치한다.
function listRead(html: string, patch: Partial<PageReadResult> = {}): PageReadResult {
  return {
    pageKind: "list",
    pageTitle: "AI가 읽은 제목",
    items: Array.from({ length: TITLE_COUNT }, (_, k) => k + 1).map((i) => ({
      titleRef: refOf(html, titleOf(i)),
      titleText: titleOf(i),
      linkRef: refOf(html, titleOf(i)),
      fields: [
        {
          key: "organization",
          label: "주최기관",
          type: "text" as const,
          role: "none" as const,
          ref: refOf(html, orgOf(i)),
          text: orgOf(i),
        },
      ],
    })),
    suggested: { displayName: "공모전 공고", categoryPath: ["공모전"], tagNames: ["아이디어"] },
    ...patch,
  };
}

function noListRead(patch: Partial<PageReadResult> = {}): PageReadResult {
  return {
    pageKind: "detail",
    pageTitle: "",
    items: [],
    suggested: { displayName: "", categoryPath: [], tagNames: [] },
    ...patch,
  };
}

function llmResult(data: PageReadResult) {
  return { data, promptTokens: 10, completionTokens: 5, durationMs: 100 };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  dbQuery.mockResolvedValue({ rows: [] });
  vi.mocked(robotsAllowed).mockResolvedValue(true);
  vi.mocked(hasLlm).mockReturnValue(true);
  vi.mocked(checkLlmQuota).mockResolvedValue(true);
  vi.mocked(recordLlmCall).mockResolvedValue(undefined);
  vi.mocked(fetchPage).mockResolvedValue(page(LIST_HTML));
  vi.mocked(renderPage).mockResolvedValue(rendered(LIST_HTML));
  vi.mocked(readPage).mockResolvedValue(llmResult(listRead(LIST_HTML)));
});

describe("analyzeUrl", () => {
  it("analyzeUrl의 모든 outcome이 analyzeResultSchema를 만족한다", async () => {
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
    vi.mocked(fetchPage).mockResolvedValueOnce(page(DETAIL_HTML));
    vi.mocked(renderPage).mockResolvedValueOnce(rendered(DETAIL_HTML));
    vi.mocked(readPage).mockResolvedValueOnce(llmResult(noListRead()));
    check(await analyzeUrl("u1", URL_IN));

    // list
    check(await analyzeUrl("u1", URL_IN));

    expect([...outcomes].sort()).toEqual(["detail", "error", "exists", "link-only", "list"].sort());
  });

  it("LLM이 읽은 목록을 llm fieldSource와 AI 필드 메타로 미리보기에 담는다", async () => {
    const r = await analyzeUrl("u1", URL_IN);

    expect(r.outcome).toBe("list");
    expect(r.fieldSource).toBe("llm");
    expect(r.preview?.fetchStrategy).toBe("html");
    expect(r.preview?.fields.find((f) => f.key === "organization")?.label).toBe("주최기관");
    expect(r.preview?.rows).toHaveLength(TITLE_COUNT);
    expect(r.preview?.rows[0]).toMatchObject({ title: titleOf(1), organization: orgOf(1) });
    expect(() => analyzeResultSchema.parse(r)).not.toThrow();
  });

  it("preview.profile이 분석 결과에 담긴다", async () => {
    const r = await analyzeUrl("u1", URL_IN);

    expect(() => fetchProfileSchema.parse(r.preview?.profile)).not.toThrow();
    // 정적 HTML과 렌더 DOM이 같으므로 렌더링이 필요 없다.
    expect(r.preview?.profile).toMatchObject({ mode: "static", measuredReadyBy: "stabilized" });
    expect(r.steps.find((s) => s.label === "수집 프로파일")).toMatchObject({ status: "ok" });
  });

  it("정적 HTML에 목록이 없고 렌더 DOM에만 있으면 렌더링 프로파일과 render 플래그를 남긴다", async () => {
    vi.mocked(fetchPage).mockResolvedValue(page(DETAIL_HTML));
    const r = await analyzeUrl("u1", URL_IN);

    expect(r.outcome).toBe("list");
    expect(r.preview?.profile).toMatchObject({
      mode: "rendered",
      waitForSelector: (r.preview?.spec as CrawlSpec).itemSelector,
    });
    expect((r.preview?.profile as { settleMs: number }).settleMs).toBeGreaterThan(0);
    expect((r.preview?.spec as CrawlSpec).render).toBe(true);
    const profileStep = r.steps.find((s) => s.label === "수집 프로파일");
    expect(profileStep?.detail).toContain("렌더링 필요");
    expect(profileStep?.detail).toContain("항목 확인 셀렉터 저장");
  });

  it("단계가 설계서 순서대로 쌓인다", async () => {
    const r = await analyzeUrl("u1", URL_IN);

    expect(r.steps.map((s) => s.label)).toEqual([
      "URL 검증",
      "기존 소스 확인",
      "robots.txt 확인",
      "페이지 접근",
      "RSS/Atom 피드 확인",
      "브라우저 렌더링",
      "AI 페이지 해석",
      "셀렉터 합성·검증",
      "수집 프로파일",
      "페이지 유형 판정",
    ]);
    expect(r.steps.find((s) => s.label === "브라우저 렌더링")?.detail).toBe("로딩 완료 2.4초 (DOM 안정화)");
  });

  it("렌더링이 실패해도 정적 HTML로 분석을 계속하고 warn을 남긴다", async () => {
    vi.mocked(renderPage).mockRejectedValue(new Error("no browser"));

    const r = await analyzeUrl("u1", URL_IN);

    expect(r.outcome).toBe("list");
    expect(r.fieldSource).toBe("llm");
    const step = r.steps.find((s) => s.label === "브라우저 렌더링");
    expect(step?.status).toBe("warn");
    expect(step?.detail).toContain("로딩 완료를 보장하지 못함");
    expect(step?.detail).not.toContain("no browser");
    expect(readPage).toHaveBeenCalledTimes(1);
  });

  it("렌더링 실패가 AppError면 그 메시지를 단계에 남기고 계속한다", async () => {
    vi.mocked(renderPage).mockRejectedValue(new AppError(errorCodes.EXTRACTION_FAILED, "브라우저 없음", 500));

    const r = await analyzeUrl("u1", URL_IN);

    expect(r.outcome).toBe("list");
    expect(r.steps.find((s) => s.label === "브라우저 렌더링")?.detail).toContain("브라우저 없음");
  });

  it("로딩 완료를 확인하지 못한 렌더링은 warn으로 남긴다", async () => {
    vi.mocked(renderPage).mockResolvedValue({
      ...rendered(LIST_HTML),
      timings: { readyMs: 20_000, readyBy: "timeout", grewByScroll: false },
    });

    const r = await analyzeUrl("u1", URL_IN);

    expect(r.steps.find((s) => s.label === "브라우저 렌더링")).toMatchObject({ status: "warn" });
  });

  it("피드 URL은 렌더링과 LLM 호출 없이 끝낸다", async () => {
    const rss = `<?xml version="1.0"?><rss version="2.0"><channel>${[1, 2, 3]
      .map((i) => `<item><title>공고 ${i}</title><link>/n/${i}</link></item>`)
      .join("")}</channel></rss>`;
    vi.mocked(fetchPage).mockResolvedValue(page(rss, { contentType: "application/rss+xml" }));

    const r = await analyzeUrl("u1", URL_IN);

    expect(r.outcome).toBe("list");
    expect(r.preview?.fetchStrategy).toBe("rss");
    expect((r.preview?.spec as CrawlSpec).strategy).toBe("rss");
    expect(r.preview?.profile).toMatchObject({ mode: "feed" });
    expect(renderPage).not.toHaveBeenCalled();
    expect(readPage).not.toHaveBeenCalled();
    expect(checkLlmQuota).not.toHaveBeenCalled();
    expect(() => analyzeResultSchema.parse(r)).not.toThrow();
  });

  it("페이지에 피드 링크가 있고 그 피드가 항목을 주면 렌더링과 LLM 호출 없이 끝낸다", async () => {
    const withLink = LIST_HTML.replace(
      "</head>",
      `<link rel="alternate" type="application/rss+xml" href="/feed.xml"></head>`,
    );
    const rss = `<?xml version="1.0"?><rss version="2.0"><channel>${[1, 2, 3]
      .map((i) => `<item><title>공고 ${i}</title><link>/n/${i}</link></item>`)
      .join("")}</channel></rss>`;
    vi.mocked(fetchPage)
      .mockResolvedValueOnce(page(withLink))
      .mockResolvedValueOnce(
        page(rss, { contentType: "application/rss+xml", finalUrl: "https://x.kr/feed.xml" }),
      );

    const r = await analyzeUrl("u1", URL_IN);

    expect(r.preview?.fetchStrategy).toBe("rss");
    expect((r.preview?.spec as CrawlSpec).feedUrl).toBe("https://x.kr/feed.xml");
    expect(renderPage).not.toHaveBeenCalled();
    expect(readPage).not.toHaveBeenCalled();
  });

  it("피드 링크가 있어도 그 피드가 비어 있으면 렌더링과 LLM 해석으로 간다", async () => {
    const withLink = LIST_HTML.replace(
      "</head>",
      `<link rel="alternate" type="application/rss+xml" href="/feed.xml"></head>`,
    );
    vi.mocked(fetchPage)
      .mockResolvedValueOnce(page(withLink))
      .mockResolvedValueOnce(page(`<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>`, {
        contentType: "application/rss+xml",
        finalUrl: "https://x.kr/feed.xml",
      }));
    vi.mocked(renderPage).mockResolvedValue(rendered(LIST_HTML));
    vi.mocked(readPage).mockResolvedValue(llmResult(listRead(LIST_HTML)));

    const r = await analyzeUrl("u1", URL_IN);

    expect(r.preview?.fetchStrategy).toBe("html");
    expect(readPage).toHaveBeenCalledTimes(1);
  });

  it("JSON-LD가 있어도 조기 채택하지 않고 렌더링·LLM 해석을 거친다", async () => {
    const ld = {
      "@context": "https://schema.org",
      "@type": "ItemList",
      itemListElement: [1, 2, 3].map((i) => ({
        "@type": "ListItem",
        item: { name: `빵부스러기 ${i}`, url: `/crumb/${i}` },
      })),
    };
    const withLd = LIST_HTML.replace(
      "</head>",
      `<script type="application/ld+json">${JSON.stringify(ld)}</script></head>`,
    );
    vi.mocked(fetchPage).mockResolvedValue(page(withLd));
    vi.mocked(renderPage).mockResolvedValue(rendered(withLd));
    vi.mocked(readPage).mockResolvedValue(llmResult(listRead(withLd)));

    const r = await analyzeUrl("u1", URL_IN);

    expect(r.preview?.fetchStrategy).toBe("html");
    expect(r.preview?.rows[0]).toMatchObject({ title: titleOf(1) });
    expect(readPage).toHaveBeenCalledTimes(1);
  });

  it("LLM을 쓸 수 없으면 휴리스틱 결과로 list를 돌려주고 폴백 단계를 남긴다", async () => {
    vi.mocked(hasLlm).mockReturnValue(false);

    const r = await analyzeUrl("u1", URL_IN);

    expect(r.outcome).toBe("list");
    expect(r.fieldSource).toBe("heuristic");
    expect(r.steps.find((s) => s.label === "AI 페이지 해석")?.detail).toContain("설정되지 않았습니다");
    expect(readPage).not.toHaveBeenCalled();
  });

  it("목록이 없다고 읽으면 detail로 끝나고 LLM 후보와 URL 경로 후보를 함께 제시한다", async () => {
    vi.mocked(fetchPage).mockResolvedValue(page(DETAIL_HTML, { finalUrl: "https://x.kr/board/view/1" }));
    vi.mocked(renderPage).mockResolvedValue(rendered(DETAIL_HTML, "https://x.kr/board/view/1"));
    vi.mocked(readPage).mockResolvedValue(
      llmResult(
        noListRead({
          pageTitle: "공고 상세",
          listCandidates: [
            { label: "공고 게시판", url: "/board" },
            { label: "지어낸 목록", url: "/fake" },
          ],
          suggested: { displayName: "공고 소스", categoryPath: [], tagNames: [] },
        }),
      ),
    );

    const r = await analyzeUrl("u1", "https://x.kr/board/view/1");

    expect(r.outcome).toBe("detail");
    expect(r.errorCode).toBe(errorCodes.PAGE_TYPE_UNKNOWN);
    expect(r.candidates[0]).toEqual({ label: "공고 게시판", url: "https://x.kr/board" });
    expect(r.candidates.map((c) => c.url)).toContain("https://x.kr/board/view");
    expect(r.candidates.map((c) => c.url)).not.toContain("https://x.kr/fake");
    expect(r.suggested.displayName).toBe("공고 소스");
    expect(r.preview).toBeNull();
    expect(() => analyzeResultSchema.parse(r)).not.toThrow();
  });

  it("제안 이름이 비면 페이지 제목을 표시 이름으로 쓴다", async () => {
    const r = await analyzeUrl("u1", URL_IN);
    expect(r.suggested.displayName).toBe("공모전 공고");

    vi.mocked(readPage).mockResolvedValue(
      llmResult(listRead(LIST_HTML, { suggested: { displayName: "", categoryPath: [], tagNames: [] } })),
    );
    const blank = await analyzeUrl("u1", URL_IN);
    expect(blank.suggested.displayName).toBe("공고 목록");
  });

  it("<title>이 비어 있으면 LLM이 읽은 페이지 제목을 쓴다", async () => {
    const untitled = LIST_HTML.replace("<title>공고 목록</title>", "");
    vi.mocked(fetchPage).mockResolvedValue(page(untitled));
    vi.mocked(renderPage).mockResolvedValue(rendered(untitled));
    vi.mocked(readPage).mockResolvedValue(llmResult(listRead(untitled)));

    const r = await analyzeUrl("u1", URL_IN);

    expect(r.pageTitle).toBe("AI가 읽은 제목");
  });

  it("<title>이 있으면 LLM 제목보다 우선한다", async () => {
    const r = await analyzeUrl("u1", URL_IN);
    expect(r.pageTitle).toBe("공고 목록");
  });

  it("사용자 힌트는 스펙에 입력 시각과 함께 남는다", async () => {
    const r = await analyzeUrl("u1", URL_IN, "아이디어 공모전");

    const spec = r.preview?.spec as CrawlSpec;
    expect(spec.hint).toBe("아이디어 공모전");
    expect(Number.isNaN(Date.parse(spec.hintSetAt ?? ""))).toBe(false);
    expect(r.pageText).toBeNull();
  });

  it("힌트가 현재 페이지에 없으면 warn과 함께 페이지 텍스트 스냅샷을 돌려준다", async () => {
    const r = await analyzeUrl("u1", URL_IN, "사라진 공고 제목");

    expect(r.steps.find((s) => s.label === "힌트 확인")).toMatchObject({ status: "warn" });
    expect(r.pageText).toContain(titleOf(1));
    expect(r.outcome).toBe("list");
  });

  it("userId·purpose·sourceId가 호출 이력에 전달된다", async () => {
    await analyzeUrl("user-7", URL_IN);

    expect(recordLlmCall).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-7", sourceId: null, purpose: "analyze-fields" }),
    );
  });
});

describe("analyzeListing", () => {
  const args = {
    userId: "u1",
    url: URL_IN,
    sourceId: null,
    purpose: "analyze-fields" as const,
  };

  it("robots 금지면 blocked에 ROBOTS_DISALLOWED를 담고 예외를 던지지 않는다", async () => {
    vi.mocked(robotsAllowed).mockResolvedValue(false);
    const r = await analyzeListing(args);
    expect(r.blocked?.code).toBe(errorCodes.ROBOTS_DISALLOWED);
    expect(r.outcome).toBeNull();
    expect(r.profile).toBeNull();
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("fetch 실패면 blocked에 그 오류 코드를 담는다", async () => {
    vi.mocked(fetchPage).mockRejectedValue(new AppError(errorCodes.URL_UNREACHABLE, "접근 불가", 502));
    const r = await analyzeListing(args);
    expect(r.blocked?.code).toBe(errorCodes.URL_UNREACHABLE);
    expect(r.outcome).toBeNull();
  });

  it("SPA hash 라우트 URL은 렌더링 시 hash를 보존한다", async () => {
    // sbiz24.kr 같은 SPA 사이트는 #/path로 페이지를 식별한다.
    // fetchPage는 hash를 서버에 보내지 않으므로 finalUrl에 hash가 없다.
    // renderPage에는 원본 URL의 hash가 복원된 URL이 전달되어야 한다.
    vi.mocked(fetchPage).mockResolvedValue(page(DETAIL_HTML, { finalUrl: "https://www.sbiz24.kr/" }));
    vi.mocked(renderPage).mockResolvedValue(rendered(LIST_HTML, "https://www.sbiz24.kr/#/combinePbancList"));

    await analyzeListing({
      ...args,
      url: "https://www.sbiz24.kr/#/combinePbancList?combine=combine",
    });

    expect(vi.mocked(renderPage).mock.calls[0][0]).toBe(
      "https://www.sbiz24.kr/#/combinePbancList?combine=combine",
    );
  });

  it("개요는 렌더된 HTML로 만들고 렌더된 URL을 기준 주소로 쓴다", async () => {
    vi.mocked(fetchPage).mockResolvedValue(page(DETAIL_HTML));
    vi.mocked(renderPage).mockResolvedValue(rendered(LIST_HTML, RENDERED_URL));

    await analyzeListing(args);

    expect(vi.mocked(readPage).mock.calls[0][0].outlineText).toContain(titleOf(1));
    expect(vi.mocked(readPage).mock.calls[0][0].pageUrl).toBe(RENDERED_URL);
  });

  describe("검증 미달 시 보수 호출", () => {
    // 항목 사이에 빈 li가 많아 itemSelector가 과포함하므로 수율이 임계치 아래로 떨어진다.
    const JUNK_HTML = LIST_HTML.replace("</ul>", `${"<li></li>".repeat(12)}</ul>`);

    beforeEach(() => {
      vi.mocked(fetchPage).mockResolvedValue(page(JUNK_HTML));
      vi.mocked(renderPage).mockResolvedValue(rendered(JUNK_HTML));
      vi.mocked(readPage).mockResolvedValue(llmResult(listRead(JUNK_HTML)));
      vi.mocked(readPageRepair).mockResolvedValue(llmResult(listRead(JUNK_HTML)));
    });

    it("기본값(allowRepair 생략)이면 보수 호출을 한다", async () => {
      const r = await analyzeListing(args);

      expect(readPageRepair).toHaveBeenCalledTimes(1);
      expect(r.steps.find((s) => s.label === "셀렉터 합성·검증")?.status).toBe("warn");
    });

    it("allowRepair=false면 보수 호출을 하지 않는다", async () => {
      await analyzeListing({ ...args, allowRepair: false });

      expect(readPageRepair).not.toHaveBeenCalled();
      expect(readPage).toHaveBeenCalledTimes(1);
    });
  });

  it("저장된 힌트의 입력 시각을 넘기면 스펙이 그 시각을 보존한다", async () => {
    const stored = "2026-01-12T00:00:00.000Z";
    const r = await analyzeListing({ ...args, hint: "아이디어 공모전", hintSetAt: stored });
    expect((r.outcome?.spec as CrawlSpec).hintSetAt).toBe(stored);
  });

  it("LLM이 어떤 방식으로 실패해도 예외를 던지지 않는다", async () => {
    vi.mocked(readPage).mockRejectedValue(new Error("boom"));
    await expect(analyzeListing(args)).resolves.toMatchObject({ blocked: null, fieldSource: "heuristic" });
  });
});
