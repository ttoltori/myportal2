import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../../config/db";
import { AppError, errorCodes } from "../../errors/error-codes";
import { sourcesSql } from "../sources/sources.sql";
import { rebuildSpec } from "../sources/sources";
import { repairSpec } from "./collector";
import { enrichWithLlm, type EnrichResult } from "./llm/enrich";
import { fetchPage } from "./fetcher";
import { renderPage } from "./render";
import type { CrawlSpec, ExtractedRow } from "./extract";

vi.mock("../../config/db", () => ({ getDb: vi.fn() }));
vi.mock("./fetcher", () => ({ fetchPage: vi.fn() }));
vi.mock("./render", () => ({ renderPage: vi.fn() }));
vi.mock("./robots", () => ({ robotsAllowed: vi.fn() }));
vi.mock("./cluster", () => ({ clusterItems: vi.fn() }));
vi.mock("../keywords/match", () => ({ matchNewItemsForSubscribers: vi.fn() }));
vi.mock("./llm/enrich", () => ({ enrichWithLlm: vi.fn() }));

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

describe("rebuildSpec", () => {
  it("userId와 purpose rebuild로 enrich를 호출한다", async () => {
    fakeDb(null);
    vi.mocked(enrichWithLlm).mockImplementation(async (args) => llmResult(args.base!.spec));

    await rebuildSpec("user-1", "src-1");

    const args = vi.mocked(enrichWithLlm).mock.calls[0][0];
    expect(args.userId).toBe("user-1");
    expect(args.purpose).toBe("rebuild");
    expect(args.sourceId).toBe("src-1");
  });

  it("LLM 보강 스펙(fieldSource 포함)을 manual 버전으로 저장한다", async () => {
    const db = fakeDb(null);
    vi.mocked(enrichWithLlm).mockImplementation(async (args) =>
      llmResult({
        ...(args.base!.spec),
        fields: { org: { selector: ".org", type: "text", label: "기관" } },
        fieldSource: "llm",
      }),
    );

    const out = await rebuildSpec("user-1", "src-1");

    expect(out.version).toBe(2);
    const saved = db.inserted();
    expect(saved?.method).toBe("manual");
    expect(saved?.json).toContain('"fieldSource":"llm"');
  });

  it("휴리스틱과 LLM 구제 모두 실패하면 EXTRACTION_FAILED를 던진다", async () => {
    fakeDb(null);
    vi.mocked(fetchPage).mockResolvedValue({ body: EMPTY_HTML, finalUrl: PAGE_URL } as never);
    vi.mocked(enrichWithLlm).mockResolvedValue(null);

    const err = await rebuildSpec("user-1", "src-1").catch((e: unknown) => e);

    expect(vi.mocked(enrichWithLlm).mock.calls[0][0].base).toBeNull();
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(errorCodes.EXTRACTION_FAILED);
  });

  it("render가 필요한 소스는 보강 스펙에도 render true가 유지된다", async () => {
    const db = fakeDb({ strategy: "html", itemSelector: "li", render: true });
    vi.mocked(enrichWithLlm).mockImplementation(async (args) => llmResult(args.base!.spec));

    await rebuildSpec("user-1", "src-1");

    expect(vi.mocked(renderPage)).toHaveBeenCalled();
    expect(db.inserted()?.json).toContain('"render":true');
  });

  it("구제 모드로 복구된 스펙에도 기존 render=true와 hint가 유지된다", async () => {
    const db = fakeDb({ strategy: "html", itemSelector: "li", render: true, hint: "공지" });
    vi.mocked(renderPage).mockResolvedValue({ html: EMPTY_HTML, finalUrl: PAGE_URL } as never);
    vi.mocked(enrichWithLlm).mockResolvedValue(
      llmResult({
        strategy: "html",
        itemSelector: "li.row",
        fields: { org: { selector: ".org", type: "text", label: "기관" } },
        fieldSource: "llm",
      }),
    );

    await rebuildSpec("user-1", "src-1");

    expect(vi.mocked(enrichWithLlm).mock.calls[0][0].base).toBeNull();
    const saved = db.inserted();
    expect(saved?.spec.render).toBe(true);
    expect(saved?.spec.hint).toBe("공지");
  });
});
