import { reanalyzeResultSchema } from "@myportal/api-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorCodes } from "../../errors/error-codes";
import { analyzeListing, type ListingAnalysis } from "../crawl/analyze";
import type { CrawlSpec, ExtractedRow } from "../crawl/extract";
import { reanalyzeSource } from "./reanalyze";
import { sourcesSql } from "./sources.sql";

const dbQuery = vi.fn();
vi.mock("../../config/db", () => ({ getDb: () => ({ query: dbQuery }) }));
// fieldsFromRows는 진짜를 쓰고, 네트워크가 걸린 analyzeListing만 교체한다.
vi.mock("../crawl/analyze", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../crawl/analyze")>()),
  analyzeListing: vi.fn(),
}));

const USER = "u1";
const SOURCE = "s1";
const SOURCE_URL = "https://x.kr/list";

interface FieldRow {
  key: string;
  label: string;
  type: string;
  role: string;
  sort_order: number;
  visible: boolean;
}

const fieldRow = (key: string, order: number): FieldRow => ({
  key,
  label: key,
  type: "text",
  role: "none",
  sort_order: order,
  visible: true,
});

// 호출 순서가 아니라 SQL 문자열로 응답을 고른다 — 구현의 쿼리 순서에 테스트가 묶이지 않게 하기 위함.
function setupDb(opts: {
  subscribed?: boolean;
  sourceExists?: boolean;
  storedSpec?: unknown;
  fields?: FieldRow[];
}) {
  const {
    subscribed = true,
    sourceExists = true,
    storedSpec = null,
    fields = [],
  } = opts;
  dbQuery.mockImplementation(async (sql: string) => {
    if (sql === sourcesSql.subscriptionForSource) {
      return { rows: subscribed ? [{ id: "sub1" }] : [] };
    }
    if (sql === sourcesSql.findById) {
      if (!sourceExists) return { rows: [] };
      return {
        rows: [
          {
            id: SOURCE,
            url: SOURCE_URL,
            normalized_url: SOURCE_URL,
            fetch_strategy: "html",
          },
        ],
      };
    }
    if (sql === sourcesSql.latestActiveSpec) {
      return {
        rows: storedSpec === null ? [] : [{ version: 1, spec: storedSpec }],
      };
    }
    if (sql === sourcesSql.fieldsForSource) return { rows: fields };
    return { rows: [] };
  });
}

const rows: ExtractedRow[] = Array.from({ length: 12 }, (_, i) => ({
  title: `제목${i}`,
  link: `https://x.kr/v/${i}`,
  publishedAt: null,
  attrs: { org: `기관${i}` },
}));

const spec: CrawlSpec = { strategy: "html", itemSelector: "li", fields: {} };

function analysis(patch: Partial<ListingAnalysis> = {}): ListingAnalysis {
  return {
    steps: [{ label: "페이지 접근", status: "ok", detail: "HTTP 200" }],
    pageTitle: "공고 목록",
    outcome: { spec, rows, strategy: "html", feedUrl: null },
    fieldSource: "llm",
    pageText: null,
    staticHtml: "<html></html>",
    finalUrl: SOURCE_URL,
    blocked: null,
    ...patch,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  setupDb({});
  vi.mocked(analyzeListing).mockResolvedValue(analysis());
});

describe("reanalyzeSource", () => {
  // 권한 판정은 sources.ts의 findSubscribedSource를 공유한다.
  // 소스 없음과 구독 안 함을 구분하는 것이 기존 엔드포인트들의 규칙이다.
  it("없는 소스는 SOURCE_NOT_FOUND 404를 던진다", async () => {
    setupDb({ sourceExists: false });
    await expect(reanalyzeSource(USER, SOURCE)).rejects.toMatchObject({
      code: errorCodes.SOURCE_NOT_FOUND,
      statusCode: 404,
    });
    expect(analyzeListing).not.toHaveBeenCalled();
  });

  it("구독하지 않은 소스는 FORBIDDEN 403을 던진다", async () => {
    setupDb({ subscribed: false });
    await expect(reanalyzeSource(USER, SOURCE)).rejects.toMatchObject({
      code: errorCodes.FORBIDDEN,
      statusCode: 403,
    });
    expect(analyzeListing).not.toHaveBeenCalled();
  });

  it("목록을 찾으면 preview와 fieldSource를 담아 반환한다", async () => {
    const res = await reanalyzeSource(USER, SOURCE);
    expect(res.outcome).toBe("list");
    expect(res.fieldSource).toBe("llm");
    expect(res.preview?.fields.length).toBeGreaterThan(0);
    expect(res.preview?.fields.map((f) => f.key)).toContain("org");
    // 등록 화면과 같은 모양: 앞 10건, attrs를 펼친 행
    expect(res.preview?.rows).toHaveLength(10);
    expect(res.preview?.rows[0]).toEqual({
      title: "제목0",
      link: "https://x.kr/v/0",
      published: null,
      org: "기관0",
    });
    expect(res.preview?.fetchStrategy).toBe("html");
    expect(res.preview?.spec).toEqual(spec);
    expect(res.errorCode).toBeNull();
  });

  it("목록을 못 찾으면 detail이고 preview는 null이다", async () => {
    vi.mocked(analyzeListing).mockResolvedValue(
      analysis({ outcome: null, fieldSource: null, pageText: "본문" }),
    );
    const res = await reanalyzeSource(USER, SOURCE);
    expect(res.outcome).toBe("detail");
    expect(res.preview).toBeNull();
    expect(res.pageText).toBe("본문");
  });

  it("robots 금지면 link-only다", async () => {
    vi.mocked(analyzeListing).mockResolvedValue(
      analysis({
        outcome: null,
        fieldSource: null,
        pageTitle: null,
        blocked: { code: errorCodes.ROBOTS_DISALLOWED, detail: "금지" },
      }),
    );
    const res = await reanalyzeSource(USER, SOURCE);
    expect(res.outcome).toBe("link-only");
    expect(res.errorCode).toBe(errorCodes.ROBOTS_DISALLOWED);
    expect(res.preview).toBeNull();
  });

  it("fetch 실패면 error다", async () => {
    vi.mocked(analyzeListing).mockResolvedValue(
      analysis({
        outcome: null,
        fieldSource: null,
        pageTitle: null,
        blocked: { code: errorCodes.URL_UNREACHABLE, detail: "실패" },
      }),
    );
    const res = await reanalyzeSource(USER, SOURCE);
    expect(res.outcome).toBe("error");
    expect(res.errorCode).toBe(errorCodes.URL_UNREACHABLE);
  });

  it("currentFields에 현재 source_fields가 담긴다", async () => {
    setupDb({
      fields: [fieldRow("title", 0), fieldRow("link", 1), fieldRow("published", 2)],
    });
    const res = await reanalyzeSource(USER, SOURCE);
    expect(res.currentFields).toHaveLength(3);
    expect(res.currentFields[0]).toMatchObject({ key: "title", sortOrder: 0 });
  });

  it("저장된 spec.hint가 기본 힌트로 analyzeListing에 전달된다", async () => {
    setupDb({ storedSpec: { strategy: "html", itemSelector: "li", hint: "공고" } });
    await reanalyzeSource(USER, SOURCE);
    expect(vi.mocked(analyzeListing).mock.calls[0]?.[0].hint).toBe("공고");
  });

  it("저장된 spec이 문자열로 와도 hint를 읽는다", async () => {
    setupDb({
      storedSpec: JSON.stringify({ strategy: "html", itemSelector: "li", hint: "공고" }),
    });
    await reanalyzeSource(USER, SOURCE);
    expect(vi.mocked(analyzeListing).mock.calls[0]?.[0].hint).toBe("공고");
  });

  it("요청 hint가 저장된 hint를 덮는다", async () => {
    setupDb({ storedSpec: { strategy: "html", itemSelector: "li", hint: "공고" } });
    await reanalyzeSource(USER, SOURCE, "장학");
    expect(vi.mocked(analyzeListing).mock.calls[0]?.[0].hint).toBe("장학");
  });

  it("purpose는 rebuild로 전달된다", async () => {
    await reanalyzeSource(USER, SOURCE);
    expect(vi.mocked(analyzeListing)).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: "rebuild",
        sourceId: SOURCE,
        userId: USER,
        url: SOURCE_URL,
      }),
    );
  });

  it("모든 outcome이 reanalyzeResultSchema를 통과한다", async () => {
    const cases: Partial<ListingAnalysis>[] = [
      {},
      { outcome: null, fieldSource: null },
      {
        outcome: null,
        fieldSource: null,
        blocked: { code: errorCodes.ROBOTS_DISALLOWED, detail: "금지" },
      },
      {
        outcome: null,
        fieldSource: null,
        blocked: { code: errorCodes.URL_UNREACHABLE, detail: "실패" },
      },
    ];
    const seen = new Set<string>();
    for (const patch of cases) {
      vi.mocked(analyzeListing).mockResolvedValue(analysis(patch));
      const res = await reanalyzeSource(USER, SOURCE);
      expect(() => reanalyzeResultSchema.parse(res)).not.toThrow();
      seen.add(res.outcome);
    }
    expect([...seen].sort()).toEqual(["detail", "error", "link-only", "list"]);
  });

  it("crawl_specs·source_fields에 쓰기를 하지 않는다", async () => {
    setupDb({
      storedSpec: { strategy: "html", itemSelector: "li" },
      fields: [fieldRow("title", 0)],
    });
    await reanalyzeSource(USER, SOURCE);
    const sqls = dbQuery.mock.calls.map((c) => String(c[0]).toLowerCase());
    expect(sqls.length).toBeGreaterThan(0);
    for (const sql of sqls) {
      expect(sql).not.toMatch(/\b(insert|update|delete)\b/);
    }
  });
});
