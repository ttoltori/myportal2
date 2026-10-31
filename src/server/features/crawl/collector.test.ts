import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../../config/db";
import { AppError, errorCodes } from "../../errors/error-codes";
import { sourcesSql } from "../sources/sources.sql";
import { collectSource, createSourceWithBaseline, repairSpec } from "./collector";
import { runAnalysis, type AnalysisOutcome } from "./analyze/run-analysis";
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
vi.mock("./analyze/run-analysis", () => ({ runAnalysis: vi.fn() }));
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

function htmlSpec(patch: Partial<CrawlSpec> = {}): CrawlSpec {
  return { strategy: "html", itemSelector: "li.row", fields: {}, ...patch };
}

// runAnalysis 결과 모양. spec이 null이면 분석 실패(목록을 못 찾음)다.
function outcome(spec: CrawlSpec | null): AnalysisOutcome {
  return {
    spec,
    rows: spec ? llmRows : [],
    strategy: "html",
    feedUrl: null,
    fieldSource: spec ? "llm" : null,
    listCandidates: [],
    suggested: { displayName: "", categoryPath: [], tagNames: [] },
    pageKind: spec ? "list" : "unknown",
    pageTitle: null,
    steps: [],
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
  const HINT_SET_AT = "2026-01-12T00:00:00.000Z";
  const prevWithHint: CrawlSpec = {
    strategy: "html",
    itemSelector: "li",
    hint: "옛 공고 제목",
    hintSetAt: HINT_SET_AT,
  };

  it("분석 결과를 self-repair 새 버전으로 저장한다", async () => {
    const db = fakeDb(null);
    vi.mocked(runAnalysis).mockResolvedValue(
      outcome({
        strategy: "html",
        itemSelector: "li.row",
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

  it("시스템 한도(userId null)·self-repair 목적·보수 호출 없이 분석한다", async () => {
    fakeDb(null);
    vi.mocked(runAnalysis).mockResolvedValue(outcome(htmlSpec()));

    await repairSpec("src-1", LIST_HTML, PAGE_URL, null);

    const args = vi.mocked(runAnalysis).mock.calls[0][0];
    expect(args.userId).toBeNull();
    expect(args.purpose).toBe("self-repair");
    expect(args.sourceId).toBe("src-1");
    expect(args.pageUrl).toBe(PAGE_URL);
    expect(args.html).toBe(LIST_HTML);
    expect(args.allowRepair).toBe(false);
  });

  describe("힌트 순서", () => {
    it("힌트 없이 먼저 분석하고 성공하면 저장된 힌트로 재분석하지 않는다", async () => {
      fakeDb(null);
      vi.mocked(runAnalysis).mockResolvedValue(outcome(htmlSpec()));

      const out = await repairSpec("src-1", LIST_HTML, PAGE_URL, prevWithHint);

      expect(out).not.toBeNull();
      expect(runAnalysis).toHaveBeenCalledTimes(1);
      expect(vi.mocked(runAnalysis).mock.calls[0][0].hint).toBeUndefined();
    });

    it("힌트 없이 실패하면 저장된 힌트와 원래 입력 시각으로 한 번 더 시도한다", async () => {
      const db = fakeDb(null);
      vi.mocked(runAnalysis)
        .mockResolvedValueOnce(outcome(null))
        .mockResolvedValueOnce(outcome(htmlSpec()));

      const out = await repairSpec("src-1", LIST_HTML, PAGE_URL, prevWithHint);

      expect(out).not.toBeNull();
      expect(runAnalysis).toHaveBeenCalledTimes(2);
      const [first, second] = vi.mocked(runAnalysis).mock.calls.map((c) => c[0]);
      expect(first.hint).toBeUndefined();
      expect(second.hint).toBe("옛 공고 제목");
      // 생략하면 runAnalysis가 "지금"으로 찍어 낡음 표시가 사라진다.
      expect(second.hintSetAt).toBe(HINT_SET_AT);
      // 두 호출 모두 보수 호출을 막아 자가복구 1회당 LLM 호출이 최대 2회다.
      expect(first.allowRepair).toBe(false);
      expect(second.allowRepair).toBe(false);
      expect(db.inserted()?.method).toBe("self-repair");
    });

    it("두 번 다 실패하면 null을 반환하고 아무것도 저장하지 않는다", async () => {
      const db = fakeDb(null);
      vi.mocked(runAnalysis).mockResolvedValue(outcome(null));

      const out = await repairSpec("src-1", LIST_HTML, PAGE_URL, prevWithHint);

      expect(out).toBeNull();
      expect(runAnalysis).toHaveBeenCalledTimes(2);
      expect(db.inserted()).toBeNull();
    });

    it("저장된 힌트가 없으면 실패해도 재시도하지 않는다", async () => {
      fakeDb(null);
      vi.mocked(runAnalysis).mockResolvedValue(outcome(null));

      const out = await repairSpec("src-1", EMPTY_HTML, PAGE_URL, { strategy: "html" });

      expect(out).toBeNull();
      expect(runAnalysis).toHaveBeenCalledTimes(1);
    });
  });

  describe("hintSetAt 보존", () => {
    // runAnalysis는 hintSetAt을 못 받으면 지금 시각으로 찍는다. 저장 단계가 그것을 믿지 않고
    // 이전 스펙의 값으로 되돌려야 재시도가 성공해도 힌트의 나이가 유지된다.
    const stampedNow = "2030-01-01T00:00:00.000Z";

    it("저장된 힌트로 재시도해 성공해도 저장되는 hintSetAt은 원래 값이다", async () => {
      const db = fakeDb(null);
      vi.mocked(runAnalysis)
        .mockResolvedValueOnce(outcome(null))
        .mockResolvedValueOnce(
          outcome(htmlSpec({ hint: "옛 공고 제목", hintSetAt: stampedNow })),
        );

      await repairSpec("src-1", LIST_HTML, PAGE_URL, prevWithHint);

      expect(db.inserted()?.spec.hint).toBe("옛 공고 제목");
      expect(db.inserted()?.spec.hintSetAt).toBe(HINT_SET_AT);
    });

    it("힌트 없이 성공해도 사용자가 입력한 힌트와 입력 시각을 지우지 않는다", async () => {
      const db = fakeDb(null);
      vi.mocked(runAnalysis).mockResolvedValue(outcome(htmlSpec()));

      await repairSpec("src-1", LIST_HTML, PAGE_URL, prevWithHint);

      expect(db.inserted()?.spec.hint).toBe("옛 공고 제목");
      expect(db.inserted()?.spec.hintSetAt).toBe(HINT_SET_AT);
    });

    it("hintSetAt이 없는 구버전 스펙은 재시도로 성공해도 시각이 생기지 않는다", async () => {
      const db = fakeDb(null);
      vi.mocked(runAnalysis)
        .mockResolvedValueOnce(outcome(null))
        .mockResolvedValueOnce(
          outcome(htmlSpec({ hint: "옛 공고 제목", hintSetAt: stampedNow })),
        );

      await repairSpec("src-1", LIST_HTML, PAGE_URL, {
        strategy: "html",
        hint: "옛 공고 제목",
      });

      expect(vi.mocked(runAnalysis).mock.calls[1][0].hintSetAt).toBeUndefined();
      expect(db.inserted()?.spec.hint).toBe("옛 공고 제목");
      expect(db.inserted()?.spec).not.toHaveProperty("hintSetAt");
    });

    it("힌트가 없던 소스의 새 스펙에는 hint와 hintSetAt이 없다", async () => {
      const db = fakeDb(null);
      vi.mocked(runAnalysis).mockResolvedValue(outcome(htmlSpec()));

      await repairSpec("src-1", LIST_HTML, PAGE_URL, { strategy: "html" });

      expect(db.inserted()?.spec).not.toHaveProperty("hint");
      expect(db.inserted()?.spec).not.toHaveProperty("hintSetAt");
    });
  });

  it("기존 render=true가 새 스펙에 유지된다", async () => {
    const db = fakeDb(null);
    vi.mocked(runAnalysis).mockResolvedValue(outcome(htmlSpec()));
    const prev: CrawlSpec = { strategy: "html", itemSelector: "li", render: true };

    await repairSpec("src-1", LIST_HTML, PAGE_URL, prev);

    expect(db.inserted()?.json).toContain('"render":true');
  });

  // 프로파일(어떻게 가져오는가)과 스펙(무엇을 뽑는가)은 수명이 다르다. 스펙을 새 버전으로
  // 교체하면서 측정한 렌더링 대기 설정을 덮어쓰면 설계 §1-3의 사고(렌더링이 필요한 소스가
  // 정적 수집으로 내려가 조용히 0건)가 재발한다.
  it("스펙을 교체해도 fetch_profile을 덮어쓰지 않는다", async () => {
    const db = fakeDb(null);
    vi.mocked(runAnalysis).mockResolvedValue(outcome(htmlSpec()));

    const out = await repairSpec("src-1", LIST_HTML, PAGE_URL, prevWithHint);

    expect(out).not.toBeNull();
    expect(db.inserted()?.method).toBe("self-repair");
    const sqls = db.query.mock.calls.map((c) => String(c[0]));
    expect(sqls).not.toContain(sourcesSql.updateFetchProfile);
    for (const sql of sqls) expect(sql).not.toMatch(/fetch_profile/i);
    // 새 스펙은 프로파일과 같은 트랜잭션으로 묶이지 않는다 — 스펙만 쓴다.
    expect(db.transaction).not.toHaveBeenCalled();
  });

  // 두 분석이 호출마다 시계를 새로 시작하면 각자 전체 예산이 남은 줄 알고 합계가 플랫폼
  // 실행 한도를 넘는다. 같은 시작 시각을 받아야 2회차가 남은 예산을 보고 스스로 판단한다.
  describe("시간 예산", () => {
    it("힌트 재시도까지 간 두 분석이 같은 startedAt을 받는다", async () => {
      fakeDb(null);
      vi.mocked(runAnalysis).mockResolvedValue(outcome(null));
      const T0 = 1_700_000_000_000;

      await repairSpec("src-1", LIST_HTML, PAGE_URL, prevWithHint, T0);

      const [first, second] = vi.mocked(runAnalysis).mock.calls.map((c) => c[0]);
      expect(first.startedAt).toBe(T0);
      expect(second.startedAt).toBe(T0);
    });

    it("1회차가 오래 걸려도 2회차의 시작 시각은 1회차와 같다 (시계를 다시 시작하지 않는다)", async () => {
      fakeDb(null);
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
        vi.mocked(runAnalysis)
          .mockImplementationOnce(async () => {
            vi.setSystemTime(new Date("2026-11-01T00:01:20Z")); // 1회차가 80초를 썼다
            return outcome(null);
          })
          .mockResolvedValueOnce(outcome(null));

        // startedAt을 생략하면 repairSpec 진입 시각이 두 호출에 공통으로 쓰인다.
        await repairSpec("src-1", LIST_HTML, PAGE_URL, prevWithHint);

        const [first, second] = vi.mocked(runAnalysis).mock.calls.map((c) => c[0]);
        expect(first.startedAt).toBe(Date.parse("2026-11-01T00:00:00Z"));
        expect(second.startedAt).toBe(first.startedAt);
      } finally {
        vi.useRealTimers();
      }
    });

    it("collectSource는 수집 시작 시각을 넘긴다 (fetch·렌더링에 쓴 시간도 예산에 든다)", async () => {
      fakeCollectDb({
        fetch_profile: { mode: "rendered", settleMs: 2000, measuredAt: MEASURED_AT },
        // LIST_HTML에 없는 셀렉터라 0건 추출이 된다.
        spec: { strategy: "html", itemSelector: "li.nomatch", fields: {} },
        consecutive_empty: 2,
      });
      vi.mocked(robotsAllowed).mockResolvedValue(true);
      vi.mocked(runAnalysis).mockResolvedValue(outcome(null));
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const t0 = new Date("2026-11-01T00:00:00Z");
        vi.setSystemTime(t0);
        vi.mocked(renderPage).mockImplementation(async () => {
          vi.setSystemTime(new Date("2026-11-01T00:00:40Z")); // 렌더링이 40초를 썼다
          return { html: LIST_HTML, finalUrl: PAGE_URL } as never;
        });

        await collectSource("src-1");

        // 렌더링이 실제로 시간을 쓴 뒤에도 기준점이 수집 시작이어야 의미 있는 단언이다.
        expect(renderPage).toHaveBeenCalled();
        expect(runAnalysis).toHaveBeenCalled();
        expect(vi.mocked(runAnalysis).mock.calls[0][0].startedAt).toBe(t0.getTime());
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("실패는 예외로 새지 않는다", () => {
    it("분석이 던져도 null을 반환한다 (힌트가 있으면 재시도까지 한다)", async () => {
      const db = fakeDb(null);
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(runAnalysis).mockRejectedValue(new Error("sk-live-SECRET provider down"));

      await expect(repairSpec("src-1", LIST_HTML, PAGE_URL, prevWithHint)).resolves.toBeNull();

      expect(runAnalysis).toHaveBeenCalledTimes(2);
      expect(db.inserted()).toBeNull();
      // 오류 원문(프로바이더 응답·키 조각이 섞일 수 있다)은 로그 인자 어디에도 없어야 한다.
      expect(errorLog).toHaveBeenCalled();
      const logged = JSON.stringify(errorLog.mock.calls);
      expect(logged).not.toContain("sk-live-SECRET");
      expect(logged).not.toContain("provider down");
      // 분류 가능한 정보(소스 id, 오류 종류)는 남는다.
      expect(logged).toContain("src-1");
      expect(logged).toContain("Error");
      errorLog.mockRestore();
    });

    it("첫 시도가 던지면 저장된 힌트로 재시도해 복구할 수 있다", async () => {
      fakeDb(null);
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(runAnalysis)
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce(outcome(htmlSpec()));

      await expect(
        repairSpec("src-1", LIST_HTML, PAGE_URL, prevWithHint),
      ).resolves.not.toBeNull();
      errorLog.mockRestore();
    });

    it("분석이 행을 0건 돌려주면 복구 실패로 본다", async () => {
      const db = fakeDb(null);
      vi.mocked(runAnalysis).mockResolvedValue({ ...outcome(htmlSpec()), rows: [] });

      expect(await repairSpec("src-1", LIST_HTML, PAGE_URL, null)).toBeNull();
      expect(db.inserted()).toBeNull();
    });

    it("JSON-LD(structured) 스펙은 html 수집 경로가 읽지 못하므로 받지 않는다", async () => {
      const db = fakeDb(null);
      vi.mocked(runAnalysis).mockResolvedValue({
        ...outcome({ strategy: "structured" }),
        strategy: "structured",
      });

      expect(await repairSpec("src-1", LIST_HTML, PAGE_URL, null)).toBeNull();
      expect(db.inserted()).toBeNull();
    });
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

// getDb()가 돌려주는 db와 트랜잭션의 tx를 별도 객체로 둔다. 같은 객체면 구현이 tx를
// 빼먹고 getDb()로 떨어져도 테스트가 통과해, 부분 실패를 남기는 회귀를 못 잡는다.
function fakeCreateDb(existingSourceId: string | null) {
  const profileWrites: unknown[][] = [];
  const txProfileWrites: unknown[][] = [];
  const dbProfileWrites: unknown[][] = [];
  const handler = (writes: unknown[][]) =>
    vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql === sourcesSql.findByNormalizedUrl) {
        return { rows: existingSourceId ? [{ id: existingSourceId }] : [] };
      }
      if (sql === sourcesSql.insertSource) return { rows: [{ id: "src-new" }] };
      if (sql === sourcesSql.insertSubscription) return { rows: [{ id: "sub-new" }] };
      if (sql === sourcesSql.updateFetchProfile) {
        profileWrites.push(params ?? []);
        writes.push(params ?? []);
        return { rows: [] };
      }
      return { rows: [] };
    });
  const tx = { query: handler(txProfileWrites) };
  const db = {
    query: handler(dbProfileWrites),
    transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
    profileWrites,
    txProfileWrites,
    dbProfileWrites,
  };
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
    // 트랜잭션의 tx로 저장해야 이후 단계가 실패했을 때 함께 롤백된다.
    expect(db.txProfileWrites).toHaveLength(1);
    expect(db.dbProfileWrites).toHaveLength(0);
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

  it("로그의 url은 JSON 문자열로 감싸 개행으로 로그를 위조하지 못하게 한다", async () => {
    fakeCreateDb(null);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await createSourceWithBaseline("user-1", {
      ...createInput({ mode: "teleport" }),
      url: "https://x.kr/list\n[collect] 위조된 줄",
    });

    expect(errSpy).toHaveBeenCalledTimes(1);
    const logged = String(errSpy.mock.calls[0][0]);
    expect(logged.includes(String.fromCharCode(10))).toBe(false);
    expect(logged).toContain(JSON.stringify("\n[collect]").slice(1, -1));
    errSpy.mockRestore();
  });

  it("기존 소스를 재사용하는 등록은 잘못된 프로파일이어도 로그를 남기지 않는다", async () => {
    // 재사용 등록은 프로파일을 쓰지 않으므로 검증 실패 로그는 소음이다.
    fakeCreateDb("src-existing");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await createSourceWithBaseline("user-1", createInput({ mode: "teleport" }));

    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("카테고리가 없어 404로 끝나는 요청은 프로파일 검증 로그를 남기지 않는다", async () => {
    fakeCreateDb(null);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      createSourceWithBaseline("user-1", {
        ...createInput({ mode: "teleport" }),
        categoryId: "missing-cat",
      }),
    ).rejects.toMatchObject({ code: errorCodes.CATEGORY_NOT_FOUND });

    expect(errSpy).not.toHaveBeenCalled();
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
  consecutive_failures?: number;
  consecutive_empty?: number;
}) {
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
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
            consecutive_failures: source.consecutive_failures ?? 0,
            consecutive_empty: source.consecutive_empty ?? 0,
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

  it("빈 배열 프로파일은 빈 값이 아니라 손상으로 보고 로그를 남긴다", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fakeCollectDb({ fetch_profile: [] });

    await collectSource("src-1");

    expect(errSpy).toHaveBeenCalledTimes(1);
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
    // CRAWL-03: 추출이 성공하는 일반 수집에서 readPage/chatJson/runAnalysis가 모두 불리지 않는다.
    fakeCollectDb({
      fetch_profile: { mode: "rendered", settleMs: 2000, measuredAt: MEASURED_AT },
    });

    const out = await collectSource("src-1");

    // 추출이 실제로 성공했어야 한다. 앞 단계에서 예외로 끊긴 경로에서도
    // "LLM 미호출"은 참이므로, 정상 수집이 끝까지 갔다는 단언이 함께 있어야 의미가 있다.
    expect(out.result).toBe("ok");
    expect(out.newCount).toBe(5);
    expect(readPage).not.toHaveBeenCalled();
    expect(chatJson).not.toHaveBeenCalled();
    expect(runAnalysis).not.toHaveBeenCalled();
  });
});

// updateAfterRun의 파라미터 위치: [id, status, lastSuccess, failures, nextCrawlAt, etag,
// lastModified, feedUrl, interval, consecutiveEmpty]
const AFTER_RUN_FAILURES = 3;
const AFTER_RUN_EMPTY = 9;

function afterRunParams(db: ReturnType<typeof fakeCollectDb>): unknown[] {
  const call = db.query.mock.calls.find(([sql]) => sql === sourcesSql.updateAfterRun);
  if (!call) throw new Error("updateAfterRun이 호출되지 않았다");
  return call[1] as unknown[];
}

describe("collectSource - 자가복구 발동 조건 (CRAWL-08)", () => {
  // LIST_HTML에 없는 셀렉터라 추출 행이 0건이다.
  const NO_MATCH_SPEC: CrawlSpec = { strategy: "html", itemSelector: "li.nomatch", fields: {} };

  beforeEach(() => {
    vi.mocked(robotsAllowed).mockResolvedValue(true);
    vi.mocked(runAnalysis).mockResolvedValue(outcome(null));
  });

  it("예외 없이 0건 추출이 임계만큼 반복되면 자가복구가 발동한다", async () => {
    // consecutive_failures는 0이다: 개편으로 0건이 되는 소스는 예외를 던지지 않는다.
    fakeCollectDb({ spec: NO_MATCH_SPEC, consecutive_failures: 0, consecutive_empty: 2 });

    await collectSource("src-1");

    expect(runAnalysis).toHaveBeenCalled();
    expect(vi.mocked(runAnalysis).mock.calls[0][0].purpose).toBe("self-repair");
  });

  it("빈 추출 횟수가 임계에 못 미치면 발동하지 않고 1 증가한다", async () => {
    const db = fakeCollectDb({ spec: NO_MATCH_SPEC, consecutive_empty: 1 });

    await collectSource("src-1");

    expect(runAnalysis).not.toHaveBeenCalled();
    expect(afterRunParams(db)[AFTER_RUN_EMPTY]).toBe(2);
  });

  it("접근 실패 횟수가 높아도 빈 추출이 아니면 발동하지 않는다", async () => {
    // 두 지표는 의미가 다르다: 예전 코드는 consecutive_failures로 판단했다.
    fakeCollectDb({ spec: NO_MATCH_SPEC, consecutive_failures: 5, consecutive_empty: 0 });

    await collectSource("src-1");

    expect(runAnalysis).not.toHaveBeenCalled();
  });

  it("추출은 됐지만 새 항목이 0건이면 발동하지 않고 빈 추출 횟수를 0으로 리셋한다", async () => {
    // 게시판에 새 글이 없어도 기존 항목은 추출된다 — 정상이다.
    const db = fakeCollectDb({ spec: ROW_SPEC, consecutive_empty: 5 });
    const base = db.query.getMockImplementation()!;
    db.query.mockImplementation(async (sql: string, params?: unknown[]) =>
      // 모든 항목이 이미 있어 insert가 아무 행도 돌려주지 않는다 (on conflict do nothing).
      sql === sourcesSql.insertItem ? { rows: [] } : base(sql, params),
    );

    const out = await collectSource("src-1");

    expect(out.newCount).toBe(0);
    expect(runAnalysis).not.toHaveBeenCalled();
    expect(afterRunParams(db)[AFTER_RUN_EMPTY]).toBe(0);
  });

  it("추출 행이 1건 이상이면 빈 추출 횟수를 0으로 리셋한다", async () => {
    const db = fakeCollectDb({ spec: ROW_SPEC, consecutive_empty: 1 });

    const out = await collectSource("src-1");

    expect(out.newCount).toBe(5);
    expect(afterRunParams(db)[AFTER_RUN_EMPTY]).toBe(0);
  });

  it("예외로 끝난 수집은 consecutive_failures만 올리고 빈 추출 횟수는 유지한다", async () => {
    const db = fakeCollectDb({ spec: ROW_SPEC, consecutive_failures: 1, consecutive_empty: 3 });
    vi.mocked(fetchPage).mockRejectedValue(new Error("연결 실패"));

    const out = await collectSource("src-1");

    expect(out.result).toBe("error");
    const params = afterRunParams(db);
    expect(params[AFTER_RUN_FAILURES]).toBe(2);
    expect(params[AFTER_RUN_EMPTY]).toBe(3);
    expect(runAnalysis).not.toHaveBeenCalled();
  });

  it("0건이면 접근 실패 횟수는 올리지 않는다", async () => {
    const db = fakeCollectDb({ spec: NO_MATCH_SPEC, consecutive_failures: 1, consecutive_empty: 0 });

    const out = await collectSource("src-1");

    expect(out.result).toBe("ok");
    const params = afterRunParams(db);
    expect(params[AFTER_RUN_FAILURES]).toBe(0);
    expect(params[AFTER_RUN_EMPTY]).toBe(1);
  });

  it("복구가 성공해 행을 되찾으면 빈 추출 횟수를 0으로 리셋한다", async () => {
    const db = fakeCollectDb({ spec: NO_MATCH_SPEC, consecutive_empty: 2 });
    vi.mocked(runAnalysis).mockResolvedValue(outcome({ strategy: "html", itemSelector: "li.row", fields: {} }));

    const out = await collectSource("src-1");

    expect(out.newCount).toBe(1);
    expect(afterRunParams(db)[AFTER_RUN_EMPTY]).toBe(0);
  });

  it("복구가 실패하면 빈 추출 횟수가 계속 올라 다음 수집에서 다시 시도한다", async () => {
    const db = fakeCollectDb({ spec: NO_MATCH_SPEC, consecutive_empty: 2 });

    await collectSource("src-1");

    expect(runAnalysis).toHaveBeenCalled();
    expect(afterRunParams(db)[AFTER_RUN_EMPTY]).toBe(3);
  });

  it("레거시 fetch_strategy='rendered' 행도 자가복구 대상이다", async () => {
    fakeCollectDb({
      fetch_strategy: "rendered",
      fetch_profile: { mode: "rendered", settleMs: 2000, measuredAt: MEASURED_AT },
      spec: NO_MATCH_SPEC,
      consecutive_empty: 2,
    });

    await collectSource("src-1");

    expect(runAnalysis).toHaveBeenCalled();
  });

  it("스펙으로 추출하지 않는 전략(rss)은 빈 추출이 반복돼도 자가복구하지 않는다", async () => {
    fakeCollectDb({
      fetch_strategy: "rss",
      fetch_profile: { mode: "feed", measuredAt: MEASURED_AT },
      spec: { strategy: "rss" },
      consecutive_empty: 9,
    });
    vi.mocked(fetchPage).mockResolvedValue({
      body: "not a feed",
      finalUrl: PAGE_URL,
      contentType: "text/html",
      etag: null,
      lastModified: null,
      status: 200,
    } as never);

    await collectSource("src-1");

    expect(runAnalysis).not.toHaveBeenCalled();
  });
});
