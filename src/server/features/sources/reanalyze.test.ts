import { reanalyzeResultSchema, type ApplySpecRequest } from "@myportal/api-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError, errorCodes } from "../../errors/error-codes";
import { analyzeListing, type ListingAnalysis } from "../crawl/analyze";
import { extractRows } from "../crawl/collector";
import type { CrawlSpec, ExtractedRow } from "../crawl/extract";
import { fetchPage } from "../crawl/fetcher";
import { dedupeHash } from "../crawl/url";
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

// ── 백필 매칭 ──────────────────────────────────────────
// dedupe_hash에 제목이 섞여 있어, URL을 1차 키로 쓰지 않으면 재적용이 전량 중복 삽입이 된다.

interface ItemFixture {
  id: string;
  normalized_url: string | null;
  dedupe_hash: string;
  collected_at: string;
}

const item = (
  id: string,
  normalizedUrl: string | null,
  hash: string,
  collectedAt = "2026-01-01",
): ItemFixture => ({
  id,
  normalized_url: normalizedUrl,
  dedupe_hash: hash,
  collected_at: collectedAt,
});

const URL_1 = "https://x.kr/v/1";
const URL_2 = "https://x.kr/v/2";
const URL_9 = "https://x.kr/v/9";

const extractedRow = (
  title: string,
  link: string | null,
  attrs: Record<string, unknown> = {},
  publishedAt: string | null = null,
): ExtractedRow => ({ title, link, publishedAt, attrs });

// 파라미터 순서: id, title, url, normalized_url, dedupe_hash, published_at, excerpt, attrs
const updateCalls = () => txCallsOf(reanalyzeSql.updateItemFromRow);
const updatedIds = () => updateCalls().map((c) => c[1]?.[0]);
const insertCalls = () => txCallsOf(sourcesSql.insertItem);
const readMarkCalls = () => txCallsOf(reanalyzeSql.markReadForUser);

describe("applySpecForSource — 백필 매칭", () => {
  const existing = [
    item("i1", URL_1, "h1", "2026-01-01"),
    item("i2", URL_2, "h2", "2026-01-02"),
    item("i3", null, dedupeHash("", "제목3"), "2026-01-03"),
  ];

  // insertItem은 새 id를 돌려주는 것으로 둔다. 삽입 id는 호출 순서대로 n1, n2, ...
  function setupTx(items: ItemFixture[], opts: { insertConflicts?: boolean } = {}) {
    let seq = 0;
    txQuery.mockImplementation(async (sql: string) => {
      if (sql === reanalyzeSql.maxSpecVersion) return { rows: [{ v: TX_MAX_VERSION }] };
      if (sql === reanalyzeSql.itemsForBackfill) return { rows: items };
      if (sql === sourcesSql.insertItem) {
        return { rows: opts.insertConflicts ? [] : [{ id: `n${++seq}` }] };
      }
      return { rows: [] };
    });
  }

  beforeEach(() => {
    vi.mocked(fetchPage).mockResolvedValue({
      finalUrl: SOURCE_URL,
      status: 200,
      contentType: "text/html",
      body: "<html></html>",
      etag: null,
      lastModified: null,
    });
    setupTx(existing);
  });

  const apply = (extracted: ExtractedRow[]) => {
    vi.mocked(extractRows).mockResolvedValue(extracted);
    return applySpecForSource(USER, SOURCE, applyInput());
  };

  it("제목이 바뀐 항목을 normalized_url로 매칭해 중복 삽입하지 않는다", async () => {
    const res = await apply([extractedRow("새 제목", URL_1, { org: "서울시" })]);
    expect(updatedIds()).toEqual(["i1"]);
    expect(insertCalls()).toHaveLength(0);
    expect(res.backfilled).toBe(1);
    expect(res.inserted).toBe(0);
  });

  it("매칭된 항목의 dedupe_hash를 새 제목 기준으로 갱신한다", async () => {
    await apply([extractedRow("새 제목", URL_1)]);
    expect(updateCalls()[0]?.[1]?.[4]).toBe(dedupeHash(URL_1, "새 제목"));
  });

  it("title·url·normalized_url·published_at·excerpt·attrs를 함께 갱신한다", async () => {
    await apply([
      extractedRow("새 제목", URL_1, { org: "서울시", description: "본문 요약" }, "2026-03-01"),
    ]);
    expect(updateCalls()[0]?.[1]).toEqual([
      "i1",
      "새 제목",
      URL_1,
      URL_1,
      dedupeHash(URL_1, "새 제목"),
      "2026-03-01",
      "본문 요약",
      JSON.stringify({ org: "서울시", description: "본문 요약" }),
    ]);
  });

  it("URL이 없는 행은 dedupe_hash로 매칭한다", async () => {
    const res = await apply([extractedRow("제목3", null, { org: "부산시" })]);
    expect(updatedIds()).toEqual(["i3"]);
    expect(insertCalls()).toHaveLength(0);
    expect(res.backfilled).toBe(1);
    // 해시가 바뀌지 않으므로 자기 자신과의 충돌로 오인해 건너뛰지 않아야 한다.
    expect(updateCalls()[0]?.[1]?.[4]).toBe(dedupeHash("", "제목3"));
  });

  it("같은 normalized_url의 기존 항목이 2건이면 collected_at이 오래된 것만 갱신한다", async () => {
    // 목록 순서와 무관하게 오래된 쪽(i1)이 선택되어야 하므로 일부러 최신 항목을 앞에 둔다.
    setupTx([item("i1b", URL_1, "h1b", "2026-02-01"), item("i1", URL_1, "h1", "2026-01-01")]);
    const res = await apply([extractedRow("새 제목", URL_1)]);
    expect(updatedIds()).toEqual(["i1"]);
    expect(insertCalls()).toHaveLength(0);
    expect(res.backfilled).toBe(1);
  });

  it("추출 행 2건이 같은 normalized_url이면 첫 행만 반영한다", async () => {
    const res = await apply([
      extractedRow("공지 고정", URL_1, { org: "첫째" }),
      extractedRow("본문 반복", URL_1, { org: "둘째" }),
    ]);
    expect(updateCalls()).toHaveLength(1);
    expect(updateCalls()[0]?.[1]?.[1]).toBe("공지 고정");
    expect(insertCalls()).toHaveLength(0);
    expect(res.backfilled).toBe(1);
  });

  it("새 해시가 다른 기존 항목의 해시와 충돌하면 그 행을 건너뛴다", async () => {
    // i2의 현재 해시가 i1의 새 해시와 같다 — 그대로 갱신하면 unique 위반이다.
    const collidingHash = dedupeHash(URL_1, "새 제목");
    setupTx([item("i1", URL_1, "h1"), item("i2", URL_2, collidingHash)]);
    const res = await apply([extractedRow("새 제목", URL_1)]);
    expect(updateCalls()).toHaveLength(0);
    expect(insertCalls()).toHaveLength(0);
    expect(res.backfilled).toBe(0);
    expect(res.inserted).toBe(0);
  });

  it("매칭되지 않은 행은 is_baseline=false로 삽입한다", async () => {
    const res = await apply([extractedRow("신규 공고", URL_9, { org: "대구시" })]);
    expect(insertCalls()).toHaveLength(1);
    expect(insertCalls()[0]?.[1]).toEqual([
      SOURCE,
      "신규 공고",
      URL_9,
      URL_9,
      dedupeHash(URL_9, "신규 공고"),
      null,
      null,
      JSON.stringify({ org: "대구시" }),
      false,
    ]);
    expect(updateCalls()).toHaveLength(0);
    expect(res.inserted).toBe(1);
    expect(res.backfilled).toBe(0);
  });

  it("신규 삽입분을 적용자의 item_states에 읽음으로 마킹한다", async () => {
    await apply([extractedRow("신규 공고", URL_9)]);
    expect(readMarkCalls().map((c) => c[1])).toEqual([[USER, "n1"]]);
  });

  it("다른 사용자의 item_states는 만들지 않는다", async () => {
    await apply([
      extractedRow("신규 A", URL_9),
      extractedRow("신규 B", "https://x.kr/v/10"),
      extractedRow("새 제목", URL_1),
    ]);
    const marks = readMarkCalls();
    expect(marks).toHaveLength(2);
    for (const c of marks) expect(c[1]?.[0]).toBe(USER);
  });

  it("백필된 기존 항목에는 읽음 마킹을 하지 않는다", async () => {
    await apply([extractedRow("새 제목", URL_1), extractedRow("제목3", null)]);
    expect(updatedIds()).toEqual(["i1", "i3"]);
    expect(readMarkCalls()).toHaveLength(0);
  });

  // insertItem의 on conflict do nothing은 행을 돌려주지 않는다 — 삽입된 것으로 세면 안 된다.
  it("insertItem이 id를 돌려주지 않으면 삽입으로 세지도 읽음 마킹하지도 않는다", async () => {
    setupTx(existing, { insertConflicts: true });
    const res = await apply([extractedRow("신규 공고", URL_9)]);
    expect(insertCalls()).toHaveLength(1);
    expect(res.inserted).toBe(0);
    expect(readMarkCalls()).toHaveLength(0);
  });

  it("백필 실패(extracted null)면 항목 조회·쓰기를 모두 건너뛴다", async () => {
    vi.mocked(fetchPage).mockRejectedValue(new AppError(errorCodes.URL_UNREACHABLE, "실패", 502));
    const res = await applySpecForSource(USER, SOURCE, applyInput());
    expect(res.backfillFailed).toBe(true);
    expect(txCallsOf(reanalyzeSql.itemsForBackfill)).toHaveLength(0);
    expect(updateCalls()).toHaveLength(0);
    expect(insertCalls()).toHaveLength(0);
  });

  it("항목 조회와 갱신 SQL은 select *를 쓰지 않는다", () => {
    expect(reanalyzeSql.itemsForBackfill).not.toMatch(/select\s+\*/i);
    expect(reanalyzeSql.itemsForBackfill).toMatch(/\$1/);
  });
});
