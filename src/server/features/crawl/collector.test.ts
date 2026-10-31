import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../../config/db";
import { AppError, errorCodes } from "../../errors/error-codes";
import { sourcesSql } from "../sources/sources.sql";
import { collectSource, createSourceWithBaseline, repairSpec } from "./collector";
import { enrichWithLlm, type EnrichResult } from "./llm/enrich";
import { fetchPage } from "./fetcher";
import { renderPage } from "./render";
import { robotsAllowed } from "./robots";
import { readPage } from "./analyze/llm-read";
import { chatJson } from "./llm/llm-client";
import type { CrawlSpec, ExtractedRow } from "./extract";

vi.mock("../../config/db", () => ({ getDb: vi.fn() }));
vi.mock("./fetcher", () => ({ fetchPage: vi.fn() }));
vi.mock("./render", () => ({ renderPage: vi.fn() }));
vi.mock("./robots", () => ({ robotsAllowed: vi.fn() }));
vi.mock("./cluster", () => ({ clusterItems: vi.fn() }));
vi.mock("../keywords/match", () => ({ matchNewItemsForSubscribers: vi.fn() }));
vi.mock("./llm/enrich", () => ({ enrichWithLlm: vi.fn() }));
// CRAWL-03: 정기 수집 경로는 LLM을 호출하면 안 된다. 호출 여부를 확인하려고 모킹한다.
vi.mock("./analyze/llm-read", () => ({ readPage: vi.fn(), readPageRepair: vi.fn() }));
vi.mock("./llm/llm-client", () => ({ chatJson: vi.fn() }));

// 휴리스틱(generateSpec)이 실제로 목록을 찾을 수 있는 최소 HTML.
const LIST_HTML = `<html><body><ul>${[1, 2, 3, 4, 5]
  .map(
    (i) =>
      `<li class="row"><a href="/n/${i}">공지사항 제목 번호 ${i} 입니다</a><span>2026-10-0${i}</span></li>`,
  )
  .join("")}</ul></body></html>`;
const EMPTY_HTML = "<html><body><p>nothing here</p></body></html>";
const PAGE_URL = "https://x.kr/list";

const llmRows: ExtractedRow[] = [
  { title: "AI 제목", link: "https://x.kr/n/1", publishedAt: null, attrs: { org: "기관A" } },
];

function llmResult(spec: CrawlSpec, source: "llm" | "heuristic" = "llm"): EnrichResult {
  return {
    spec,
    rows: llmRows,
    fieldSource: source,
    step: { label: "AI 필드 분석", status: "ok", detail: "" },
  };
}

interface FakeDb {
  query: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
  inserted: () => { spec: CrawlSpec; json: string; method: string } | null;
}

// sourcesSql 상수로 분기하는 가짜 DB. 실제 접속은 하지 않는다.
function fakeDb(activeSpec: CrawlSpec | null): FakeDb {
  let insertParams: unknown[] | null = null;
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql === sourcesSql.latestActiveSpec) {
      return { rows: activeSpec ? [{ version: 1, spec: activeSpec }] : [] };
    }
    if (sql === sourcesSql.subscriptionForSource) {
      return { rows: [{ id: "sub-1", display_name: "x", category_id: null, paused: false }] };
    }
    if (sql === sourcesSql.findById) {
      return { rows: [{ id: "src-1", url: PAGE_URL }] };
    }
    if (sql === sourcesSql.insertSpec) {
      insertParams = params ?? null;
      return { rows: [] };
    }
    if (sql.includes("max(version)")) return { rows: [{ v: 1 }] };
    return { rows: [] };
  });
  const db: FakeDb = {
    query,
    transaction: vi.fn(),
    inserted: () => {
      if (!insertParams) return null;
      const json = String(insertParams[2]);
      return { spec: JSON.parse(json) as CrawlSpec, json, method: String(insertParams[3]) };
    },
  };
  db.transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(db));
  vi.mocked(getDb).mockReturnValue(db as never);
  return db;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchPage).mockResolvedValue({
    body: LIST_HTML,
    finalUrl: PAGE_URL,
    contentType: "text/html",
    etag: null,
    lastModified: null,
    status: 200,
  } as never);
  vi.mocked(renderPage).mockResolvedValue({ html: LIST_HTML, finalUrl: PAGE_URL } as never);
});

describe("repairSpec", () => {
  it("LLM 보강 스펙을 self-repair 새 버전으로 저장한다", async () => {
    const db = fakeDb(null);
    vi.mocked(enrichWithLlm).mockImplementation(async (args) =>
      llmResult({
        ...(args.base!.spec),
        fields: { org: { selector: ".org", type: "text", label: "기관" } },
        fieldSource: "llm",
      }),
    );

    const out = await repairSpec("src-1", LIST_HTML, PAGE_URL, null);

    expect(out?.rows).toEqual(llmRows);
    const saved = db.inserted();
    expect(saved?.method).toBe("self-repair");
    expect(saved?.json).toContain("org");
    expect(saved?.json).toContain('"fieldSource":"llm"');
  });

  it("LLM이 실패해도 휴리스틱 스펙은 저장된다 (fields 비어 있음)", async () => {
    const db = fakeDb(null);
    vi.mocked(enrichWithLlm).mockImplementation(async (args) =>
      llmResult(args.base!.spec, "heuristic"),
    );

    const out = await repairSpec("src-1", LIST_HTML, PAGE_URL, null);

    expect(out).not.toBeNull();
    const saved = db.inserted();
    expect(saved?.method).toBe("self-repair");
    expect(saved?.spec.fieldSource).not.toBe("llm");
    expect(Object.keys(saved?.spec.fields ?? {})).toHaveLength(0);
  });

  it("userId null, purpose self-repair, 휴리스틱 결과를 base로 enrich를 호출한다", async () => {
    fakeDb(null);
    vi.mocked(enrichWithLlm).mockImplementation(async (args) => llmResult(args.base!.spec));

    await repairSpec("src-1", LIST_HTML, PAGE_URL, null);

    const args = vi.mocked(enrichWithLlm).mock.calls[0][0];
    expect(args.userId).toBeNull();
    expect(args.purpose).toBe("self-repair");
    expect(args.sourceId).toBe("src-1");
    expect(args.pageUrl).toBe(PAGE_URL);
    expect(args.base?.spec.strategy).toBe("html");
  });

  it("휴리스틱이 실패하면 base null로 구제를 시도하고, 구제도 실패하면 null을 반환한다", async () => {
    const db = fakeDb(null);
    vi.mocked(enrichWithLlm).mockResolvedValue(null);

    const out = await repairSpec("src-1", EMPTY_HTML, PAGE_URL, null);

    expect(vi.mocked(enrichWithLlm).mock.calls[0][0].base).toBeNull();
    expect(out).toBeNull();
    expect(db.inserted()).toBeNull();
  });

  it("보강 스펙에도 기존 render=true가 유지된다", async () => {
    const db = fakeDb(null);
    vi.mocked(enrichWithLlm).mockImplementation(async (args) => llmResult(args.base!.spec));
    const prev: CrawlSpec = { strategy: "html", itemSelector: "li", render: true };

    await repairSpec("src-1", LIST_HTML, PAGE_URL, prev);

    expect(db.inserted()?.json).toContain('"render":true');
  });

  it("구제 모드로 복구된 스펙에도 기존 render=true와 hint가 유지된다", async () => {
    const db = fakeDb(null);
    // 구제 결과에는 render/hint가 없다 — enrichWithLlm의 실제 동작과 동일.
    vi.mocked(enrichWithLlm).mockResolvedValue(
      llmResult({
        strategy: "html",
        itemSelector: "li.row",
        fields: { org: { selector: ".org", type: "text", label: "기관" } },
        fieldSource: "llm",
      }),
    );
    const prev: CrawlSpec = { strategy: "html", itemSelector: "li", render: true, hint: "공지" };

    const out = await repairSpec("src-1", EMPTY_HTML, PAGE_URL, prev);

    expect(vi.mocked(enrichWithLlm).mock.calls[0][0].base).toBeNull();
    expect(out?.spec.render).toBe(true);
    const saved = db.inserted();
    expect(saved?.spec.render).toBe(true);
    expect(saved?.spec.hint).toBe("공지");
    expect(saved?.spec.fieldSource).toBe("llm");
  });

  it("enrich가 rows 0건을 돌려주면 복구 실패로 본다", async () => {
    const db = fakeDb(null);
    vi.mocked(enrichWithLlm).mockResolvedValue({
      ...llmResult({ strategy: "html", itemSelector: "li" }),
      rows: [],
    });

    const out = await repairSpec("src-1", LIST_HTML, PAGE_URL, null);

    expect(out).toBeNull();
    expect(db.inserted()).toBeNull();
  });
});

// ── createSourceWithBaseline: 수집 프로파일 저장 ───────────
// 클라이언트가 보낸 프로파일은 신뢰하지 않고 서버에서 다시 검증한다.

const VALID_PROFILE = {
  mode: "rendered",
  waitForSelector: "li.row",
  settleMs: 3000,
  measuredAt: "2026-10-31T00:00:00.000Z",
};

function fakeCreateDb(existingSourceId: string | null) {
  const profileWrites: unknown[][] = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql === sourcesSql.findByNormalizedUrl) {
      return { rows: existingSourceId ? [{ id: existingSourceId }] : [] };
    }
    if (sql === sourcesSql.insertSource) return { rows: [{ id: "src-new" }] };
    if (sql === sourcesSql.insertSubscription) return { rows: [{ id: "sub-new" }] };
    if (sql === sourcesSql.updateFetchProfile) {
      profileWrites.push(params ?? []);
      return { rows: [] };
    }
    return { rows: [] };
  });
  const db = { query, transaction: vi.fn(), profileWrites };
  db.transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(db));
  vi.mocked(getDb).mockReturnValue(db as never);
  return db;
}

function createInput(profile?: unknown) {
  return {
    url: PAGE_URL,
    displayName: "공지",
    categoryId: null,
    tagNames: [],
    fields: [],
    fetchStrategy: "html",
    linkOnly: false,
    spec: { strategy: "html", itemSelector: "li.row" } as CrawlSpec,
    previewRows: llmRows,
    profile,
  };
}

describe("createSourceWithBaseline - 수집 프로파일", () => {
  it("createSource가 전달된 프로파일을 검증해 저장한다", async () => {
    const db = fakeCreateDb(null);

    await createSourceWithBaseline("user-1", createInput(VALID_PROFILE));

    expect(db.profileWrites).toHaveLength(1);
    expect(db.profileWrites[0][0]).toBe("src-new");
    expect(JSON.parse(String(db.profileWrites[0][1]))).toEqual(VALID_PROFILE);
  });

  it("프로파일이 스키마에 맞지 않으면 무시하고 프로파일 없이 등록한다", async () => {
    const db = fakeCreateDb(null);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // mode 값이 틀리고 measuredAt이 없다 — 클라이언트 값은 신뢰하지 않는다.
    const out = await createSourceWithBaseline(
      "user-1",
      createInput({ mode: "teleport", settleMs: -5 }),
    );

    expect(out.sourceId).toBe("src-new");
    expect(out.subscriptionId).toBe("sub-new");
    expect(db.profileWrites).toHaveLength(0);
    // 폐기는 흔적을 남기되 클라이언트가 보낸 원본 값은 로그에 싣지 않는다.
    expect(errSpy).toHaveBeenCalledTimes(1);
    const logged = String(errSpy.mock.calls[0][0]);
    expect(logged).toContain("[source-create]");
    expect(logged).toContain(PAGE_URL);
    expect(logged).not.toContain("teleport");
    errSpy.mockRestore();
  });

  it("프로파일이 없으면 fetch_profile을 건드리지 않는다", async () => {
    const db = fakeCreateDb(null);

    await createSourceWithBaseline("user-1", createInput(undefined));
    await createSourceWithBaseline("user-1", createInput(null));

    expect(db.profileWrites).toHaveLength(0);
  });

  it("기존 소스를 재사용하는 등록은 프로파일을 덮어쓰지 않는다", async () => {
    // 다른 사용자가 이미 등록한 소스의 수집 설정을 신규 구독이 바꿔선 안 된다.
    const db = fakeCreateDb("src-existing");

    const out = await createSourceWithBaseline("user-1", createInput(VALID_PROFILE));

    expect(out.reusedExisting).toBe(true);
    expect(out.sourceId).toBe("src-existing");
    expect(db.profileWrites).toHaveLength(0);
  });
});


// ── collectSource: 수집 프로파일로 가져오기 ────────────────
// fetch_profile이 어떻게 가져올지(모드·대기 설정)를 정한다.

const ROW_SPEC: CrawlSpec = { strategy: "html", itemSelector: "li.row" };
const MEASURED_AT = "2026-10-31T00:00:00.000Z";

function fakeCollectDb(source: {
  fetch_strategy?: string;
  fetch_profile?: unknown;
  spec?: CrawlSpec | null;
  etag?: string | null;
  last_modified?: string | null;
  feed_url?: string | null;
}) {
  const query = vi.fn(async (sql: string) => {
    if (sql === sourcesSql.findById) {
      return {
        rows: [
          {
            id: "src-1",
            url: PAGE_URL,
            normalized_url: PAGE_URL,
            kind: "list",
            fetch_strategy: source.fetch_strategy ?? "html",
            status: "ok",
            interval_minutes: 60,
            fixed_interval: false,
            etag: source.etag ?? null,
            last_modified: source.last_modified ?? null,
            feed_url: source.feed_url ?? null,
            consecutive_failures: 0,
            fetch_profile: source.fetch_profile ?? {},
          },
        ],
      };
    }
    if (sql === sourcesSql.latestActiveSpec) {
      const spec = source.spec === undefined ? ROW_SPEC : source.spec;
      return { rows: spec ? [{ version: 1, spec }] : [] };
    }
    if (sql === sourcesSql.insertRun) return { rows: [{ id: "run-1" }] };
    if (sql === sourcesSql.insertItem) return { rows: [{ id: "item-1" }] };
    return { rows: [] };
  });
  const db = { query, transaction: vi.fn() };
  vi.mocked(getDb).mockReturnValue(db as never);
  return db;
}

describe("collectSource - 수집 프로파일", () => {
  beforeEach(() => {
    vi.mocked(robotsAllowed).mockResolvedValue(true);
  });

  it("mode=rendered면 프로파일의 waitForSelector와 settleMs로 렌더링한다", async () => {
    fakeCollectDb({
      fetch_profile: {
        mode: "rendered",
        waitForSelector: "li.row",
        settleMs: 3000,
        measuredAt: MEASURED_AT,
      },
    });

    const out = await collectSource("src-1");

    expect(out.result).toBe("ok");
    expect(renderPage).toHaveBeenCalledTimes(1);
    expect(renderPage).toHaveBeenCalledWith(PAGE_URL, {
      waitForSelector: "li.row",
      settleMs: 3000,
    });
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("mode=static이면 ETag 조건부 요청으로 fetch한다", async () => {
    fakeCollectDb({
      fetch_profile: { mode: "static", measuredAt: MEASURED_AT },
      etag: '"abc"',
      last_modified: "Sat, 31 Oct 2026 00:00:00 GMT",
    });

    await collectSource("src-1");

    expect(renderPage).not.toHaveBeenCalled();
    expect(fetchPage).toHaveBeenCalledWith(PAGE_URL, {
      etag: '"abc"',
      lastModified: "Sat, 31 Oct 2026 00:00:00 GMT",
    });
  });

  it("static에서 304가 오면 unchanged로 끝낸다", async () => {
    fakeCollectDb({ fetch_profile: { mode: "static", measuredAt: MEASURED_AT } });
    vi.mocked(fetchPage).mockResolvedValue({
      body: "",
      finalUrl: PAGE_URL,
      contentType: "",
      etag: '"abc"',
      lastModified: null,
      status: 304,
    } as never);

    const out = await collectSource("src-1");

    expect(out.result).toBe("unchanged");
  });

  it("렌더링 소스는 ETag를 보내지 않는다", async () => {
    fakeCollectDb({
      fetch_profile: { mode: "rendered", settleMs: 2000, measuredAt: MEASURED_AT },
      etag: '"abc"',
    });

    await collectSource("src-1");

    expect(fetchPage).not.toHaveBeenCalled();
    expect(renderPage).toHaveBeenCalledWith(PAGE_URL, { settleMs: 2000 });
  });

  it("프로파일이 비어 있고 spec.render가 true면 렌더링한다", async () => {
    // 마이그레이션 직후 기존 소스: fetch_profile = '{}'
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fakeCollectDb({ fetch_profile: {}, spec: { ...ROW_SPEC, render: true } });

    await collectSource("src-1");

    // 측정값이 없으므로 대기 옵션 없이 renderPage 기본값을 쓴다.
    expect(renderPage).toHaveBeenCalledWith(PAGE_URL, {});
    expect(fetchPage).not.toHaveBeenCalled();
    // 빈 값은 정상적인 레거시 상태라 경고 로그를 남기지 않는다.
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("프로파일이 비어 있고 spec.render가 없으면 정적으로 fetch한다", async () => {
    fakeCollectDb({ fetch_profile: {} });

    await collectSource("src-1");

    expect(renderPage).not.toHaveBeenCalled();
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("프로파일이 손상되면 spec.render로 폴백하고 원본 값 없이 로그를 남긴다", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // settleMs 0은 Playwright에서 무제한 대기라 스키마가 막아야 하는 값이다.
    fakeCollectDb({
      fetch_profile: { mode: "rendered", settleMs: 0, secret: "LEAK-ME" },
      spec: { ...ROW_SPEC, render: true },
    });

    await collectSource("src-1");

    // 검증을 우회한 settleMs: 0이 renderPage에 넘어가면 안 된다.
    expect(renderPage).toHaveBeenCalledWith(PAGE_URL, {});
    expect(errSpy).toHaveBeenCalledTimes(1);
    const logged = String(errSpy.mock.calls[0][0]);
    expect(logged).toContain("[collect]");
    expect(logged).toContain("src-1");
    expect(logged).not.toContain("LEAK-ME");
    errSpy.mockRestore();
  });

  it("프로파일이 손상되고 spec.render도 없으면 정적 폴백을 로그로 드러낸다", async () => {
    // 렌더링이 필요한 소스가 흔적 없이 정적 수집으로 내려가는 바로 그 사고.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fakeCollectDb({ fetch_profile: "not-json{" });

    await collectSource("src-1");

    expect(renderPage).not.toHaveBeenCalled();
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it("fetch_strategy가 rendered인 기존 소스를 html과 같이 처리한다", async () => {
    const db = fakeCollectDb({
      fetch_strategy: "rendered",
      fetch_profile: { mode: "rendered", settleMs: 2000, measuredAt: MEASURED_AT },
    });

    const out = await collectSource("src-1");

    expect(out.newCount).toBe(5);
    const inserts = db.query.mock.calls.filter(([sql]) => sql === sourcesSql.insertItem);
    expect(inserts).toHaveLength(5);
  });

  it("mode=feed면 렌더링 없이 피드를 fetch한다", async () => {
    fakeCollectDb({
      fetch_strategy: "rss",
      fetch_profile: { mode: "feed", measuredAt: MEASURED_AT },
      spec: { strategy: "rss" },
    });
    vi.mocked(fetchPage).mockResolvedValue({
      body: `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
        <item><title>피드 항목</title><link>https://x.kr/f/1</link></item></channel></rss>`,
      finalUrl: PAGE_URL,
      contentType: "application/rss+xml",
      etag: null,
      lastModified: null,
      status: 200,
    } as never);

    const out = await collectSource("src-1");

    expect(renderPage).not.toHaveBeenCalled();
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(out.newCount).toBe(1);
  });

  it("scrollToBottom이 저장되어 있으면 렌더 옵션으로 넘긴다", async () => {
    fakeCollectDb({
      fetch_profile: {
        mode: "rendered",
        waitForSelector: "li.row",
        settleMs: 4000,
        scrollToBottom: true,
        measuredAt: MEASURED_AT,
      },
    });

    await collectSource("src-1");

    expect(renderPage).toHaveBeenCalledWith(PAGE_URL, {
      waitForSelector: "li.row",
      settleMs: 4000,
      scrollToBottom: true,
    });
  });

  it("정기 수집 경로에서 LLM을 호출하지 않는다", async () => {
    // CRAWL-03: 추출이 성공하는 일반 수집에서 readPage/chatJson/enrich가 모두 불리지 않는다.
    fakeCollectDb({
      fetch_profile: { mode: "rendered", settleMs: 2000, measuredAt: MEASURED_AT },
    });

    await collectSource("src-1");

    expect(readPage).not.toHaveBeenCalled();
    expect(chatJson).not.toHaveBeenCalled();
    expect(enrichWithLlm).not.toHaveBeenCalled();
  });
});
