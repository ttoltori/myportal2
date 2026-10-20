import { reanalyzeResultSchema, type ApplySpecRequest } from "@myportal/api-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError, errorCodes } from "../../errors/error-codes";
import { analyzeListing, type ListingAnalysis } from "../crawl/analyze";
import { extractRows } from "../crawl/collector";
import type { CrawlSpec, ExtractedRow } from "../crawl/extract";
import { fetchPage } from "../crawl/fetcher";
import { renderPage } from "../crawl/render";
import { applySpecForSource, reanalyzeSource } from "./reanalyze";
import { reanalyzeSql } from "./reanalyze.sql";
import { sourcesSql } from "./sources.sql";

const dbQuery = vi.fn();
// 트랜잭션 안의 쿼리는 txQuery로 갈라 둔다 — 쓰기가 트랜잭션 안에서만 일어남을 검증하기 위함.
const txQuery = vi.fn();
vi.mock("../../config/db", () => ({
  getDb: () => ({
    query: dbQuery,
    transaction: async (cb: (tx: { query: typeof txQuery }) => Promise<unknown>) =>
      cb({ query: txQuery }),
  }),
}));
// extractRows·fetchPage·renderPage는 네트워크가 걸리므로 교체한다. 나머지는 진짜를 쓴다.
vi.mock("../crawl/collector", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../crawl/collector")>()),
  extractRows: vi.fn(),
}));
vi.mock("../crawl/fetcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../crawl/fetcher")>()),
  fetchPage: vi.fn(),
}));
vi.mock("../crawl/render", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../crawl/render")>()),
  renderPage: vi.fn(),
}));
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
  status?: string;
}) {
  const {
    subscribed = true,
    sourceExists = true,
    storedSpec = null,
    fields = [],
    status = "ok",
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
            status,
            feed_url: null,
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

// ── applySpecForSource ─────────────────────────────────

const applySpec: CrawlSpec = { strategy: "html", itemSelector: "li", fields: {} };
const TX_MAX_VERSION = 3;

const applyFields = (...keys: string[]): ApplySpecRequest["fields"] =>
  keys.map((key, i) => ({
    key,
    label: key,
    type: "text",
    role: "none",
    visible: true,
    sortOrder: i,
  }));

function applyInput(patch: Partial<ApplySpecRequest> = {}): ApplySpecRequest {
  return {
    spec: applySpec,
    fields: applyFields("title", "link", "org", "deadline"),
    fetchStrategy: "html",
    ...patch,
  };
}

const txSqls = () => txQuery.mock.calls.map((c) => String(c[0]));
const txCallsOf = (sql: string) => txQuery.mock.calls.filter((c) => c[0] === sql);
const savedSpecJson = () =>
  JSON.parse(String(txCallsOf(sourcesSql.insertSpec)[0]?.[1]?.[2])) as CrawlSpec;

describe("applySpecForSource", () => {
  beforeEach(() => {
    txQuery.mockImplementation(async (sql: string) => {
      if (sql === reanalyzeSql.maxSpecVersion) return { rows: [{ v: TX_MAX_VERSION }] };
      return { rows: [] };
    });
    vi.mocked(fetchPage).mockResolvedValue({
      finalUrl: SOURCE_URL,
      status: 200,
      contentType: "text/html",
      body: "<html></html>",
      etag: null,
      lastModified: null,
    });
    vi.mocked(renderPage).mockResolvedValue({
      finalUrl: SOURCE_URL,
      html: "<html>rendered</html>",
    });
    vi.mocked(extractRows).mockResolvedValue(rows);
  });

  // 검증 실패 시 트랜잭션이 열리지 않고, 트랜잭션 밖에서도 쓰기가 없어야 한다.
  const expectNothingSaved = () => {
    expect(txQuery).not.toHaveBeenCalled();
    for (const c of dbQuery.mock.calls) {
      expect(String(c[0]).toLowerCase()).not.toMatch(/\b(insert|update|delete)\b/);
    }
  };

  it("spec이 null이면 VALIDATION_ERROR로 거부한다", async () => {
    await expect(
      applySpecForSource(USER, SOURCE, applyInput({ spec: null })),
    ).rejects.toMatchObject({ code: errorCodes.VALIDATION_ERROR });
    expectNothingSaved();
  });

  it("spec이 객체가 아니면 VALIDATION_ERROR로 거부한다", async () => {
    for (const spec of ["문자열", 42, [applySpec]]) {
      await expect(
        applySpecForSource(USER, SOURCE, applyInput({ spec })),
      ).rejects.toMatchObject({ code: errorCodes.VALIDATION_ERROR });
    }
    expectNothingSaved();
  });

  it("fields에 key가 중복되면 VALIDATION_ERROR로 거부한다", async () => {
    await expect(
      applySpecForSource(
        USER,
        SOURCE,
        applyInput({ fields: applyFields("org", "link", "org") }),
      ),
    ).rejects.toMatchObject({ code: errorCodes.VALIDATION_ERROR });
    expect(txCallsOf(sourcesSql.insertField)).toHaveLength(0);
    expectNothingSaved();
  });

  it("추출이 0건이면 EXTRACTION_FAILED이고 스펙을 저장하지 않는다", async () => {
    vi.mocked(extractRows).mockResolvedValue([]);
    await expect(applySpecForSource(USER, SOURCE, applyInput())).rejects.toMatchObject({
      code: errorCodes.EXTRACTION_FAILED,
      statusCode: 422,
    });
    expect(txCallsOf(sourcesSql.insertSpec)).toHaveLength(0);
    expectNothingSaved();
  });

  it("새 스펙을 maxVersion+1 버전·manual로 저장한다", async () => {
    const res = await applySpecForSource(USER, SOURCE, applyInput());
    const [call] = txCallsOf(sourcesSql.insertSpec);
    expect(call?.[1]?.[0]).toBe(SOURCE);
    expect(call?.[1]?.[1]).toBe(TX_MAX_VERSION + 1);
    expect(call?.[1]?.[3]).toBe("manual");
    expect(res.version).toBe(TX_MAX_VERSION + 1);
  });

  it("저장 순서는 deactivate → insertSpec → insertField → sources 갱신 → manual_actions다", async () => {
    await applySpecForSource(USER, SOURCE, applyInput());
    const watched = [
      sourcesSql.deactivateSpecs,
      sourcesSql.insertSpec,
      sourcesSql.insertField,
      reanalyzeSql.updateSourceAfterApply,
      sourcesSql.insertManualAction,
    ];
    const order = txSqls().filter((s) => watched.includes(s));
    expect(order).toEqual([
      sourcesSql.deactivateSpecs,
      sourcesSql.insertSpec,
      sourcesSql.insertField,
      sourcesSql.insertField,
      sourcesSql.insertField,
      sourcesSql.insertField,
      reanalyzeSql.updateSourceAfterApply,
      sourcesSql.insertManualAction,
    ]);
  });

  it("fields를 insertField로 업서트한다", async () => {
    const res = await applySpecForSource(USER, SOURCE, applyInput());
    const calls = txCallsOf(sourcesSql.insertField);
    expect(calls).toHaveLength(4);
    expect(calls[2]?.[1]).toEqual([SOURCE, "org", "org", "text", "none", 2, true]);
    expect(res.fieldsSaved).toBe(4);
  });

  it("사용자가 보낸 목록에 없는 기존 필드는 삭제하지 않는다", async () => {
    await applySpecForSource(USER, SOURCE, applyInput());
    const all = [...txSqls(), ...dbQuery.mock.calls.map((c) => String(c[0]))];
    for (const sql of all) {
      expect(sql.toLowerCase()).not.toMatch(/delete\s+from\s+myportal\.source_fields/);
    }
  });

  it("fetch_strategy를 요청값으로 저장한다", async () => {
    await applySpecForSource(USER, SOURCE, applyInput({ fetchStrategy: "rss" }));
    const [call] = txCallsOf(reanalyzeSql.updateSourceAfterApply);
    expect(call?.[1]?.slice(0, 3)).toEqual([SOURCE, "rss", "ok"]);
  });

  // 수집 경로의 rss 분기는 sources.feed_url만 읽는다. 새로 발견한 피드를
  // 옮기지 않으면 HTML 페이지를 피드로 읽어 영구히 0건이 된다.
  it("새로 발견한 spec.feedUrl을 sources.feed_url로 옮긴다", async () => {
    await applySpecForSource(
      USER,
      SOURCE,
      applyInput({
        fetchStrategy: "rss",
        spec: { strategy: "rss", feedUrl: "https://x.kr/rss.xml" },
      }),
    );
    const [call] = txCallsOf(reanalyzeSql.updateSourceAfterApply);
    expect(call?.[1]?.[3]).toBe("https://x.kr/rss.xml");
  });

  it("spec에 feedUrl이 없으면 null을 넘겨 기존 feed_url을 지우지 않는다", async () => {
    await applySpecForSource(USER, SOURCE, applyInput());
    const [call] = txCallsOf(reanalyzeSql.updateSourceAfterApply);
    expect(call?.[1]?.[3]).toBeNull();
    expect(reanalyzeSql.updateSourceAfterApply).toMatch(
      /feed_url\s*=\s*coalesce\(\$4,\s*feed_url\)/,
    );
  });

  it("status가 fail이면 ok로 바꾸고 consecutive_failures를 0으로 만든다", async () => {
    setupDb({ status: "fail" });
    await applySpecForSource(USER, SOURCE, applyInput());
    const [call] = txCallsOf(reanalyzeSql.updateSourceAfterApply);
    expect(call?.[1]?.[2]).toBe("ok");
    // 리셋은 파라미터가 아니라 SQL 상수가 고정으로 처리한다.
    expect(reanalyzeSql.updateSourceAfterApply).toMatch(/consecutive_failures\s*=\s*0/);
  });

  it("paused 소스는 status를 ok로 덮지 않는다", async () => {
    setupDb({ status: "pause" });
    await applySpecForSource(USER, SOURCE, applyInput());
    const [call] = txCallsOf(reanalyzeSql.updateSourceAfterApply);
    expect(call?.[1]?.[2]).toBe("pause");
  });

  it("spec.hint에 요청 hint를 저장하고 입력 spec은 변형하지 않는다", async () => {
    await applySpecForSource(USER, SOURCE, applyInput({ hint: "장학" }));
    expect(savedSpecJson().hint).toBe("장학");
    expect(applySpec.hint).toBeUndefined();
  });

  it("hint가 없으면 spec을 그대로 저장한다", async () => {
    await applySpecForSource(USER, SOURCE, applyInput());
    expect(savedSpecJson()).toEqual(applySpec);
  });

  it("manual_actions에 apply-spec을 기록한다", async () => {
    await applySpecForSource(USER, SOURCE, applyInput());
    const [call] = txCallsOf(sourcesSql.insertManualAction);
    expect(call?.[1]).toEqual([USER, SOURCE, "apply-spec"]);
  });

  it("fetch 실패면 스펙·필드는 저장하고 backfillFailed true로 응답한다", async () => {
    vi.mocked(fetchPage).mockRejectedValue(
      new AppError(errorCodes.URL_UNREACHABLE, "실패", 502),
    );
    const res = await applySpecForSource(USER, SOURCE, applyInput());
    expect(res).toEqual({
      version: TX_MAX_VERSION + 1,
      fieldsSaved: 4,
      backfilled: 0,
      inserted: 0,
      backfillFailed: true,
    });
    expect(extractRows).not.toHaveBeenCalled();
    expect(txCallsOf(sourcesSql.insertSpec)).toHaveLength(1);
  });

  it("spec.render가 true면 renderPage로 페이지를 받는다", async () => {
    await applySpecForSource(
      USER,
      SOURCE,
      applyInput({ spec: { ...applySpec, render: true } }),
    );
    expect(renderPage).toHaveBeenCalledWith(SOURCE_URL);
    expect(fetchPage).not.toHaveBeenCalled();
    expect(vi.mocked(extractRows).mock.calls[0]?.[2]).toBe("<html>rendered</html>");
  });

  it("render가 아니면 fetchPage로 받는다", async () => {
    await applySpecForSource(USER, SOURCE, applyInput());
    expect(fetchPage).toHaveBeenCalledWith(SOURCE_URL);
    expect(renderPage).not.toHaveBeenCalled();
  });

  it("fetchStrategy가 rss면 extractRows에 rss로 전달한다", async () => {
    await applySpecForSource(USER, SOURCE, applyInput({ fetchStrategy: "rss" }));
    expect(vi.mocked(extractRows).mock.calls[0]?.[0]).toMatchObject({
      url: SOURCE_URL,
      fetch_strategy: "rss",
    });
  });

  it("구독하지 않은 소스는 FORBIDDEN이고 페이지를 받지 않는다", async () => {
    setupDb({ subscribed: false });
    await expect(applySpecForSource(USER, SOURCE, applyInput())).rejects.toMatchObject({
      code: errorCodes.FORBIDDEN,
    });
    expect(fetchPage).not.toHaveBeenCalled();
    expect(txQuery).not.toHaveBeenCalled();
  });
});
