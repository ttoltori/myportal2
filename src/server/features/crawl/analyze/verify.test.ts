import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PageReadResult } from "./llm-read";
import { TITLE_MAX_LENGTH, type CrawlSpec } from "../extract";
import { pruneFailedFields, verifySpec, type VerifyScore } from "./verify";

type ReadItem = PageReadResult["items"][number];
type ReadField = ReadItem["fields"][number];

const PAGE_URL = "https://www.example.kr/list";

// verifySpec은 ref를 보지 않고 보고된 텍스트만 쓴다. ref는 타입을 맞추기 위한 자리표시다.
const PLACEHOLDER_REF = 1;

function readOf(items: ReadItem[]): PageReadResult {
  return {
    pageKind: "list",
    pageTitle: "",
    items,
    suggested: { displayName: "", categoryPath: [], tagNames: [] },
  };
}

function reportedField(key: string, text: string): ReadField {
  return { key, label: key, type: "text", role: "none", ref: PLACEHOLDER_REF, text };
}

function reportedItem(titleText: string, fields: ReadField[] = []): ReadItem {
  return { titleRef: PLACEHOLDER_REF, titleText, fields };
}

const page = (body: string): string => `<html><body>${body}</body></html>`;

// ── 합성 목록 ──
// 행 번호를 세 자리로 맞춘다. "…1"이 "…10"에 포함되어 제목 대응이 헷갈리는 일을 막는다.

const num = (n: number): string => String(n).padStart(3, "0");
const titleOf = (n: number): string => `공고 제목 번호 ${num(n)}`;
const orgOf = (n: number): string => `기관 ${num(n)}`;

// 제목 앵커(a.t)와 기관(span.org)을 가진 공고 한 줄.
function realRow(n: number, withOrg = true): string {
  const org = withOrg ? `<span class="org">${orgOf(n)}</span>` : "";
  return `<li class="row"><a class="t" href="/p/${n}">${titleOf(n)}</a>${org}</li>`;
}

// 같은 셀렉터(li.row)에 잡히지만 제목 구조(a.t)가 없는 메뉴 항목. 앵커가 6자 미만이라
// applyDomSpec이 제목을 못 찾고 건너뛴다 — 과포함이 수율로 드러나는 경로다.
function menuRow(n: number): string {
  return `<li class="row"><a href="/m/${n}">메뉴</a></li>`;
}

function listPage(real: number, junk: number, opts: { junkFirst?: boolean } = {}): string {
  const reals = Array.from({ length: real }, (_, i) => realRow(i + 1));
  const junks = Array.from({ length: junk }, (_, i) => menuRow(i + 1));
  const rows = opts.junkFirst ? [...junks, ...reals] : [...reals, ...junks];
  return page(`<ul id="board">${rows.join("")}</ul>`);
}

const BASE_SPEC: CrawlSpec = {
  strategy: "html",
  itemSelector: "li.row",
  titleSelector: "a.t",
  linkSelector: "a.t",
  fields: {},
  fieldSource: "llm",
};

const ORG_FIELD = { selector: "span.org", label: "기관", type: "text", role: "none" } as const;

// 1..count번 공고를 보고한 read. 기관 필드는 옵션.
function reportRows(count: number, withOrg = false): PageReadResult {
  return readOf(
    Array.from({ length: count }, (_, i) =>
      reportedItem(titleOf(i + 1), withOrg ? [reportedField("org", orgOf(i + 1))] : []),
    ),
  );
}

// 행은 rowCount개뿐인데 reportedCount개를 보고한다. 모자란 만큼은 앞쪽 제목을 반복해
// 제목 일치율을 1로 두고 "행 수" 규칙만 따로 검증하기 위한 구성이다.
function reportCycling(reportedCount: number, rowCount: number): PageReadResult {
  return readOf(Array.from({ length: reportedCount }, (_, i) => reportedItem(titleOf((i % rowCount) + 1))));
}

function verify(html: string, spec: CrawlSpec, read: PageReadResult) {
  return verifySpec(html, PAGE_URL, spec, read);
}

// ── 행 수율: 과포함 ──

describe("행 수율 (셀렉터 과포함)", () => {
  it("메뉴 li 20개와 공고 li 5개를 함께 잡으면 rowYield 0.2로 ok=false", () => {
    const { rows, score } = verify(listPage(5, 20), BASE_SPEC, reportRows(5));
    expect(score.matchedCount).toBe(25);
    expect(score.itemCount).toBe(5);
    expect(rows).toHaveLength(5);
    expect(score.rowYield).toBeCloseTo(0.2);
    // 제목 일치율은 과포함을 못 잡는다. 이 값이 100%여도 수율이 낮으면 폐기해야 한다.
    expect(score.titleMatchRate).toBe(1);
    expect(score.ok).toBe(false);
  });

  it("수율 경계: 0.6은 통과하고 0.59는 실패한다", () => {
    const pass = verify(listPage(60, 40), BASE_SPEC, reportRows(10)).score;
    expect(pass.matchedCount).toBe(100);
    expect(pass.rowYield).toBe(0.6);
    expect(pass.ok).toBe(true);

    const fail = verify(listPage(59, 41), BASE_SPEC, reportRows(10)).score;
    expect(fail.matchedCount).toBe(100);
    expect(fail.rowYield).toBe(0.59);
    expect(fail.ok).toBe(false);
  });

  it("작은 목록에서도 3/5 = 0.6은 통과한다", () => {
    const { score } = verify(listPage(3, 2), BASE_SPEC, reportRows(3));
    expect(score.rowYield).toBe(0.6);
    expect(score.ok).toBe(true);
  });

  it("matchedCount는 applySpec처럼 100으로 상한을 둔다", () => {
    // 앞 100개 요소 = 공고 60 + 메뉴 40. 상한이 없으면 분모가 120이 되어 0.5로 틀어진다.
    const { score } = verify(listPage(60, 60), BASE_SPEC, reportRows(10));
    expect(score.matchedCount).toBe(100);
    expect(score.itemCount).toBe(60);
    expect(score.rowYield).toBe(0.6);
    expect(score.ok).toBe(true);
  });

  it("stripNoise가 지운 영역의 요소는 matchedCount에 세지 않는다", () => {
    const html = page(`
      <nav><ul>${Array.from({ length: 30 }, (_, i) => menuRow(i)).join("")}</ul></nav>
      <ul>${[1, 2, 3, 4].map((n) => realRow(n)).join("")}</ul>
    `);
    const { score } = verify(html, BASE_SPEC, reportRows(4));
    expect(score.matchedCount).toBe(4);
    expect(score.rowYield).toBe(1);
    expect(score.ok).toBe(true);
  });

  it("매칭 요소가 하나도 없으면 수율 0으로 ok=false (0으로 나누지 않는다)", () => {
    const { rows, score } = verify(listPage(5, 0), { ...BASE_SPEC, itemSelector: "li.none" }, reportRows(5));
    expect(rows).toEqual([]);
    expect(score.matchedCount).toBe(0);
    expect(score.rowYield).toBe(0);
    expect(Number.isNaN(score.rowYield)).toBe(false);
    expect(score.ok).toBe(false);
  });
});

// ── 행 수 ──

describe("추출 행 수", () => {
  it("추출 행이 3건 미만이면 수율과 제목이 완벽해도 ok=false", () => {
    const { score } = verify(listPage(2, 0), BASE_SPEC, reportRows(2));
    expect(score.itemCount).toBe(2);
    expect(score.rowYield).toBe(1);
    expect(score.titleMatchRate).toBe(1);
    expect(score.ok).toBe(false);
  });

  it("추출 행이 정확히 3건이면 통과한다", () => {
    expect(verify(listPage(3, 0), BASE_SPEC, reportRows(3)).score.ok).toBe(true);
  });

  it("행 수가 min(보고 수,10)의 0.7 미만이면 ok=false, 이상이면 통과 (보고 10건)", () => {
    expect(verify(listPage(6, 0), BASE_SPEC, reportCycling(10, 6)).score.ok).toBe(false);
    expect(verify(listPage(7, 0), BASE_SPEC, reportCycling(10, 7)).score.ok).toBe(true);
  });

  it("작은 보고에서도 경계가 맞다: 보고 5건에 3행은 3 < 3.5로 실패, 보고 4건에 3행은 3 ≥ 2.8로 통과", () => {
    expect(verify(listPage(3, 0), BASE_SPEC, reportCycling(5, 3)).score.ok).toBe(false);
    expect(verify(listPage(3, 0), BASE_SPEC, reportCycling(4, 3)).score.ok).toBe(true);
  });

  it("보고 항목이 12건이어도 기준은 10건으로 계산한다", () => {
    // 12건 기준이면 8.4행이 필요해 7행은 실패해야 한다. 10건에서 끊으면 7행이면 된다.
    expect(verify(listPage(7, 0), BASE_SPEC, reportCycling(12, 7)).score.ok).toBe(true);
    expect(verify(listPage(6, 0), BASE_SPEC, reportCycling(12, 6)).score.ok).toBe(false);
  });
});

// ── 제목 일치율 ──

describe("제목 일치율", () => {
  // 앞쪽 realCount건은 실제 제목, 나머지는 페이지에 없는 제목을 보고한다.
  function reportWithFakes(total: number, realCount: number): PageReadResult {
    return readOf(
      Array.from({ length: total }, (_, i) =>
        reportedItem(i < realCount ? titleOf(i + 1) : `페이지에 없는 제목 ${num(i + 1)}`),
      ),
    );
  }

  it("경계 0.8은 통과한다 (보고 5건 중 4건)", () => {
    const { score } = verify(listPage(10, 0), BASE_SPEC, reportWithFakes(5, 4));
    expect(score.titleMatchRate).toBe(0.8);
    expect(score.ok).toBe(true);
  });

  it("0.8 직전은 실패한다 (보고 9건 중 7건 = 0.78)", () => {
    const { score } = verify(listPage(10, 0), BASE_SPEC, reportWithFakes(9, 7));
    expect(score.titleMatchRate).toBeCloseTo(7 / 9);
    expect(score.ok).toBe(false);
  });

  // 스키마상 보고는 12건까지라 0.79를 정확히 만들 수 없다. 함수 자체의 비교가 0.8 경계인지 100건으로 고정한다.
  it("0.79는 실패하고 0.80은 통과한다 (보고 100건 기준)", () => {
    const html = listPage(100, 0);
    const pass = verify(html, BASE_SPEC, reportWithFakes(100, 80)).score;
    expect(pass.titleMatchRate).toBe(0.8);
    expect(pass.ok).toBe(true);

    const fail = verify(html, BASE_SPEC, reportWithFakes(100, 79)).score;
    expect(fail.titleMatchRate).toBe(0.79);
    expect(fail.ok).toBe(false);
  });

  it("보고한 항목이 없으면 ok=false이고 0으로 나누지 않는다", () => {
    const { score } = verify(listPage(5, 0), BASE_SPEC, readOf([]));
    expect(score.reportedCount).toBe(0);
    expect(score.titleMatchRate).toBe(0);
    expect(score.ok).toBe(false);
  });

  it("공백과 대소문자 차이는 무시한다", () => {
    const html = page(`<ul>${[1, 2, 3]
      .map((n) => `<li class="row"><a class="t" href="/p/${n}">  Grant   Program  ${n}\n공고  </a></li>`)
      .join("")}</ul>`);
    const read = readOf([1, 2, 3].map((n) => reportedItem(`grant program ${n} 공고`)));
    expect(verify(html, BASE_SPEC, read).score.titleMatchRate).toBe(1);
  });

  it("행 제목이 보고한 제목을 포함하면 일치하고, 보고한 제목이 더 길면 불일치다 (단방향)", () => {
    const html = page(`<ul>${[1, 2, 3]
      .map((n) => `<li class="row"><a class="t" href="/p/${n}">[공지] 사업 안내 ${n}번</a></li>`)
      .join("")}</ul>`);
    const shorter = readOf([1, 2, 3].map((n) => reportedItem(`사업 안내 ${n}번`)));
    expect(verify(html, BASE_SPEC, shorter).score.titleMatchRate).toBe(1);
    const longer = readOf([1, 2, 3].map((n) => reportedItem(`[공지] 사업 안내 ${n}번 (마감 임박)`)));
    expect(verify(html, BASE_SPEC, longer).score.titleMatchRate).toBe(0);
  });

  it("행 제목은 TITLE_MAX_LENGTH로 잘리므로 더 긴 보고 제목도 같은 길이로 잘라 비교한다", () => {
    // 400자 제목: LLM은 400자를 보고하고 추출은 300자만 돌려준다. 자르지 않고 비교하면 항상 불일치다.
    const longTitle = (n: number): string => `${n}번 ${"긴제목".repeat(133)}`.slice(0, 400);
    expect(longTitle(1)).toHaveLength(400);
    const html = page(`<ul>${[1, 2, 3]
      .map((n) => `<li class="row"><a class="t" href="/p/${n}">${longTitle(n)}</a></li>`)
      .join("")}</ul>`);
    const read = readOf([1, 2, 3].map((n) => reportedItem(longTitle(n))));
    const { rows, score } = verify(html, BASE_SPEC, read);
    expect(rows[0].title).toHaveLength(TITLE_MAX_LENGTH);
    expect(score.titleMatchRate).toBe(1);
    expect(score.ok).toBe(true);
  });

  it("빈 제목은 어떤 행과도 일치하지 않는다", () => {
    const read = readOf([reportedItem(""), reportedItem(titleOf(1)), reportedItem(titleOf(2)), reportedItem(titleOf(3))]);
    const { score } = verify(listPage(3, 0), BASE_SPEC, read);
    expect(score.titleMatchRate).toBe(0.75);
    expect(score.ok).toBe(false);
  });
});

// ── 필드 채움률·일치율 ──

describe("필드 지표", () => {
  const ORG_SPEC: CrawlSpec = { ...BASE_SPEC, fields: { org: { ...ORG_FIELD } } };

  function orgPage(rowCount: number, withOrg: (n: number) => boolean): string {
    return page(`<ul>${Array.from({ length: rowCount }, (_, i) => realRow(i + 1, withOrg(i + 1))).join("")}</ul>`);
  }

  it("채움률 0.3 미만인 필드는 fieldRates에 낮게 기록하되 전체는 ok=true", () => {
    // 10행 중 2행에만 기관이 있다.
    const html = orgPage(10, (n) => n <= 2);
    const { score } = verify(html, ORG_SPEC, reportRows(10, false));
    expect(score.fieldRates.org.fill).toBe(0.2);
    expect(score.ok).toBe(true);
    expect(pruneFailedFields(ORG_SPEC, score).fields).toEqual({});
  });

  it("채움률 경계: 0.3은 유지하고 0.29는 제거한다 (100행)", () => {
    const keep = verify(orgPage(100, (n) => n <= 30), ORG_SPEC, reportRows(10, false)).score;
    expect(keep.fieldRates.org.fill).toBe(0.3);
    expect(pruneFailedFields(ORG_SPEC, keep).fields).toHaveProperty("org");

    const drop = verify(orgPage(100, (n) => n <= 29), ORG_SPEC, reportRows(10, false)).score;
    expect(drop.fieldRates.org.fill).toBe(0.29);
    expect(pruneFailedFields(ORG_SPEC, drop).fields).toEqual({});
  });

  it("추출 값이 보고한 값과 다르면 일치율 0으로 제거 대상이 된다", () => {
    const read = readOf(Array.from({ length: 5 }, (_, i) => reportedItem(titleOf(i + 1), [reportedField("org", "전혀 다른 기관")])));
    const { score } = verify(orgPage(5, () => true), ORG_SPEC, read);
    expect(score.fieldRates.org).toEqual({ fill: 1, match: 0 });
    expect(score.ok).toBe(true);
    expect(pruneFailedFields(ORG_SPEC, score).fields).toEqual({});
  });

  it("일치율 경계: 0.5는 유지하고 0.4는 제거한다 (10행)", () => {
    const withWrong = (rightCount: number): PageReadResult =>
      readOf(
        Array.from({ length: 10 }, (_, i) =>
          reportedItem(titleOf(i + 1), [reportedField("org", i < rightCount ? orgOf(i + 1) : "다른 기관")]),
        ),
      );
    const html = orgPage(10, () => true);

    const keep = verify(html, ORG_SPEC, withWrong(5)).score;
    expect(keep.fieldRates.org.match).toBe(0.5);
    expect(pruneFailedFields(ORG_SPEC, keep).fields).toHaveProperty("org");

    const drop = verify(html, ORG_SPEC, withWrong(4)).score;
    expect(drop.fieldRates.org.match).toBe(0.4);
    expect(pruneFailedFields(ORG_SPEC, drop).fields).toEqual({});
  });

  it("값 비교는 추출값 ⊇ 보고값 단방향이다: 한 칸 밀린 짧은 값은 불일치", () => {
    // 셀렉터가 한 칸 밀려 "번호"만 집은 상황. 보고한 값이 추출값을 포함하는 방향까지 허용하면 통과해 버린다.
    const html = page(`<ul>${[1, 2, 3]
      .map((n) => `<li class="row"><a class="t" href="/p/${n}">${titleOf(n)}</a><span class="org">기관</span></li>`)
      .join("")}</ul>`);
    const read = readOf([1, 2, 3].map((n) => reportedItem(titleOf(n), [reportedField("org", orgOf(n))])));
    expect(verify(html, ORG_SPEC, read).score.fieldRates.org.match).toBe(0);

    // 추출값이 더 길면(꾸밈이 붙은 경우) 보고값을 포함하므로 일치다.
    const wrapped = page(`<ul>${[1, 2, 3]
      .map((n) => `<li class="row"><a class="t" href="/p/${n}">${titleOf(n)}</a><span class="org">${orgOf(n)} (본점)</span></li>`)
      .join("")}</ul>`);
    expect(verify(wrapped, ORG_SPEC, read).score.fieldRates.org.match).toBe(1);
  });

  it("같은 제목이 반복돼도 항목을 서로 다른 행에 대응시켜 필드 값을 대조한다", () => {
    const html = page(`<ul>${[1, 2, 3]
      .map((n) => `<li class="row"><a class="t" href="/p/${n}">공고 안내문입니다</a><span class="org">${orgOf(n)}</span></li>`)
      .join("")}</ul>`);
    const read = readOf([1, 2, 3].map((n) => reportedItem("공고 안내문입니다", [reportedField("org", orgOf(n))])));
    expect(verify(html, ORG_SPEC, read).score.fieldRates.org).toEqual({ fill: 1, match: 1 });
  });

  it("속성값 필드(href 등)는 보이는 텍스트와 비교할 수 없어 채움률만 본다", () => {
    const spec: CrawlSpec = {
      ...BASE_SPEC,
      fields: { page_url: { selector: "a.t", attr: "href", label: "링크", type: "url", role: "none" } },
    };
    const read = readOf([1, 2, 3].map((n) => reportedItem(titleOf(n), [reportedField("page_url", titleOf(n))])));
    const { score } = verify(listPage(3, 0), spec, read);
    expect(score.fieldRates.page_url).toEqual({ fill: 1, match: 1 });
  });

  it("보고에 없는 필드는 채움률만 판정한다", () => {
    const { score } = verify(orgPage(5, () => true), ORG_SPEC, reportRows(5, false));
    expect(score.fieldRates.org).toEqual({ fill: 1, match: 1 });
  });

  it("행이 없으면 필드는 채움률 0이라 제거 대상이다", () => {
    const { score } = verify(listPage(5, 0), { ...ORG_SPEC, itemSelector: "li.none" }, reportRows(5, true));
    expect(score.fieldRates.org.fill).toBe(0);
    expect(pruneFailedFields(ORG_SPEC, score).fields).toEqual({});
  });
});

// ── pruneFailedFields ──

describe("pruneFailedFields", () => {
  const spec: CrawlSpec = {
    strategy: "html",
    itemSelector: "li.row",
    titleSelector: "a.t",
    publishedSelector: "time",
    fields: {
      good: { selector: ".good", label: "좋음", type: "text", role: "none" },
      sparse: { selector: ".sparse", label: "드묾", type: "text", role: "none" },
      wrong: { selector: ".wrong", label: "틀림", type: "text", role: "none" },
    },
    fieldSource: "llm",
  };

  function scoreWith(fieldRates: VerifyScore["fieldRates"]): VerifyScore {
    return { itemCount: 5, matchedCount: 5, reportedCount: 5, rowYield: 1, titleMatchRate: 1, fieldRates, ok: true };
  }

  it("임계치를 넘는 필드는 보존하고 미달 필드만 제거한다", () => {
    const pruned = pruneFailedFields(
      spec,
      scoreWith({ good: { fill: 1, match: 1 }, sparse: { fill: 0.1, match: 1 }, wrong: { fill: 1, match: 0.1 } }),
    );
    expect(Object.keys(pruned.fields ?? {})).toEqual(["good"]);
    expect(pruned.fields?.good).toEqual(spec.fields?.good);
    // 필드 밖의 스펙 속성은 그대로다.
    expect(pruned).toMatchObject({
      strategy: "html",
      itemSelector: "li.row",
      titleSelector: "a.t",
      publishedSelector: "time",
      fieldSource: "llm",
    });
  });

  it("채움률 경계: 0.3은 보존, 0.29는 제거", () => {
    const keep = pruneFailedFields(spec, scoreWith({ good: { fill: 0.3, match: 1 } }));
    expect(keep.fields).toHaveProperty("good");
    const drop = pruneFailedFields(spec, scoreWith({ good: { fill: 0.29, match: 1 } }));
    expect(drop.fields).not.toHaveProperty("good");
  });

  it("일치율 경계: 0.5는 보존, 0.49는 제거", () => {
    const keep = pruneFailedFields(spec, scoreWith({ good: { fill: 1, match: 0.5 } }));
    expect(keep.fields).toHaveProperty("good");
    const drop = pruneFailedFields(spec, scoreWith({ good: { fill: 1, match: 0.49 } }));
    expect(drop.fields).not.toHaveProperty("good");
  });

  it("점수에 없는 필드는 판단 근거가 없으므로 남긴다", () => {
    const pruned = pruneFailedFields(spec, scoreWith({ sparse: { fill: 0, match: 0 } }));
    expect(Object.keys(pruned.fields ?? {})).toEqual(["good", "wrong"]);
  });

  it("입력 스펙을 변형하지 않고 새 객체를 돌려준다", () => {
    const before = JSON.parse(JSON.stringify(spec)) as CrawlSpec;
    const pruned = pruneFailedFields(spec, scoreWith({ good: { fill: 0, match: 0 } }));
    expect(spec).toEqual(before);
    expect(pruned).not.toBe(spec);
    expect(pruned.fields).not.toBe(spec.fields);
    expect(pruned.fields?.wrong).not.toBe(spec.fields?.wrong);
    expect(spec.fields).toHaveProperty("good");
  });

  it("fields가 없는 스펙도 그대로 새 객체로 돌려준다", () => {
    const bare: CrawlSpec = { strategy: "html", itemSelector: "li" };
    const pruned = pruneFailedFields(bare, scoreWith({}));
    expect(pruned).toEqual(bare);
    expect(pruned).not.toBe(bare);
  });
});

// ── 깨진 스펙 ──

describe("깨진 스펙은 예외 없이 ok=false로 환원한다", () => {
  const html = listPage(5, 0);
  const read = reportRows(5, true);

  function expectFailed(result: ReturnType<typeof verify>) {
    expect(result.rows).toEqual([]);
    expect(result.score).toMatchObject({ itemCount: 0, matchedCount: 0, rowYield: 0, titleMatchRate: 0, ok: false });
  }

  it("itemSelector 문법이 깨져 있으면", () => {
    for (const itemSelector of ["li[", "li..row", ">>", "li:nth-child(", ""]) {
      expect(() => verify(html, { ...BASE_SPEC, itemSelector }, read)).not.toThrow();
      expectFailed(verify(html, { ...BASE_SPEC, itemSelector }, read));
    }
  });

  it("html이 빈 문자열이어도 던지지 않는다", () => {
    expect(() => verify("", BASE_SPEC, read)).not.toThrow();
    expectFailed(verify("", BASE_SPEC, read));
  });

  it("itemSelector가 없으면", () => {
    const { itemSelector: _omit, ...withoutSelector } = BASE_SPEC;
    expectFailed(verify(html, withoutSelector, read));
  });

  it("실패해도 fieldRates에는 스펙의 필드가 0으로 기록된다", () => {
    const spec: CrawlSpec = { ...BASE_SPEC, itemSelector: "li[", fields: { org: { ...ORG_FIELD } } };
    const { score } = verify(html, spec, read);
    expect(score.fieldRates.org).toEqual({ fill: 0, match: 0 });
    expect(score.reportedCount).toBe(5);
  });

  it("필드 셀렉터 문법이 깨져 있으면 그 필드만 실패하고 나머지 추출은 계속된다", () => {
    const spec: CrawlSpec = {
      ...BASE_SPEC,
      fields: { org: { ...ORG_FIELD }, bad: { selector: "span[", label: "깨짐", type: "text", role: "none" } },
    };
    const { rows, score } = verify(html, spec, read);
    expect(rows).toHaveLength(5);
    expect(score.ok).toBe(true);
    expect(score.fieldRates.bad).toEqual({ fill: 0, match: 0 });
    expect(score.fieldRates.org).toEqual({ fill: 1, match: 1 });
    expect(Object.keys(pruneFailedFields(spec, score).fields ?? {})).toEqual(["org"]);
  });

  it("verifySpec은 입력 스펙을 변형하지 않는다 (깨진 필드가 있어도)", () => {
    const spec: CrawlSpec = {
      ...BASE_SPEC,
      fields: { org: { ...ORG_FIELD }, bad: { selector: "span[", label: "깨짐", type: "text", role: "none" } },
    };
    const before = JSON.parse(JSON.stringify(spec)) as CrawlSpec;
    verify(html, spec, read);
    expect(spec).toEqual(before);
  });

  it("titleSelector 문법이 깨져 있어도 던지지 않고 기존 추측 경로로 행을 만든다", () => {
    const { score } = verify(html, { ...BASE_SPEC, titleSelector: "a[" }, reportRows(5));
    expect(score.itemCount).toBe(5);
    expect(score.ok).toBe(true);
  });
});

// ── 픽스처 4종: 정상 스펙의 실제 지표 ──
// 스펙은 selector-synthesis가 이 픽스처에서 만들어 낸 결과를 손으로 옮겨 적은 것이다.
// 합성 모듈을 import하지 않으므로 합성 쪽이 바뀌어도 이 테스트는 검증 임계치의 현실성만 본다.

interface FixtureCase {
  name: string;
  file: string;
  pageUrl: string;
  spec: CrawlSpec;
  read: PageReadResult;
}

function loadFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}.html`, import.meta.url)), "utf-8");
}

const text = (selector: string, label: string) => ({
  selector,
  label,
  type: "text" as const,
  role: "none" as const,
});

const TABLE_BOARD: FixtureCase = {
  name: "테이블 게시판",
  file: "table-board",
  pageUrl: "https://www.example.kr/notice/list.it",
  spec: {
    strategy: "html",
    itemSelector: "table.board-list tbody > tr",
    titleSelector: "td.subject > a:nth-child(1)",
    linkSelector: "td.subject > a:nth-child(1)",
    publishedSelector: "td:nth-child(5) > time:nth-child(1)",
    fields: {
      no: { selector: "td:nth-child(1)", label: "번호", type: "number", role: "none" },
      organization: text("td:nth-child(3)", "기관"),
      apply_period: { selector: "td:nth-child(4)", label: "접수기간", type: "date_range", role: "deadline" },
    },
    fieldSource: "llm",
  },
  read: readOf(
    [
      ["2026년 AI 바우처 지원사업 공고", "4", "정보통신산업진흥원", "2026-01-05 ~ 2026-02-03"],
      ["데이터 활용 중소기업 모집 안내", "3", "한국데이터산업진흥원", "2025-12-01 ~ 2025-12-31"],
      ["스마트공장 구축 지원사업 참여기업 공모", "2", "중소벤처기업진흥공단", "2025-11-10 ~ 2025-11-30"],
      ["수출 바우처 사업 수행기관 추가 모집", "1", "대한무역투자진흥공사", "2025-10-01 ~ 2025-10-15"],
    ].map(([title, no, org, period]) =>
      reportedItem(title, [
        reportedField("no", no),
        reportedField("organization", org),
        reportedField("apply_period", period),
      ]),
    ),
  ),
};

const CARD_GRID: FixtureCase = {
  name: "카드 그리드",
  file: "card-grid",
  pageUrl: "https://www.example.kr/contest",
  spec: {
    strategy: "html",
    itemSelector: "div.card",
    titleSelector: "div.body > h3.tit > a:nth-child(1)",
    linkSelector: "div.body > h3.tit > a:nth-child(1)",
    fields: {
      poster_url: { selector: "a.thumb", attr: "href", label: "포스터 링크", type: "url", role: "none" },
      thumbnail: { selector: "a.thumb > img:nth-child(1)", attr: "src", label: "썸네일", type: "image", role: "none" },
      organizer: text("div.body > p.org", "주최"),
      prize: text("div.body > p.prize", "상금"),
      summary: { selector: "div.body > p.desc > a:nth-child(1)", label: "요약", type: "text", role: "summary" },
      d_day: { selector: "div.body > span.dday", label: "남은 기간", type: "text", role: "deadline" },
    },
    fieldSource: "llm",
  },
  read: readOf(
    [
      ["청년 창업 아이디어 공모전", "주최: 창업진흥원", "총 상금 5,000만원", "D-3", "청년 창업가를 발굴하기 위해 마련된 이번 공모전은 아이디어 단계의 팀도 참여할 수 있으며 우수 팀에는 사업화 자금이 지원됩니다"],
      ["공공데이터 활용 경진대회", "주최: 행정안전부", "총 상금 3,000만원", "D-10", "공공데이터를 활용한 서비스 아이디어와 개발 부문으로 나누어 접수하며 수상 팀에는 장관상과 상금이 수여됩니다"],
      ["지역 관광 영상 공모전", "주최: 한국관광공사", "총 상금 2,000만원", "D-21", "우리 지역의 숨은 관광지를 영상으로 소개하는 공모전으로 일반인과 학생 모두 참여할 수 있습니다"],
    ].map(([title, org, prize, dday, desc]) =>
      reportedItem(title, [
        reportedField("poster_url", ""),
        reportedField("thumbnail", `${title} 포스터`),
        reportedField("organizer", org),
        reportedField("prize", prize),
        reportedField("summary", desc),
        reportedField("d_day", dday),
      ]),
    ),
  ),
};

const UL_LIST: FixtureCase = {
  name: "ul>li (앵커 안쪽 span)",
  file: "ul-list",
  pageUrl: "https://www.example.kr/news",
  spec: {
    strategy: "html",
    itemSelector: "li.item",
    titleSelector: "a:nth-child(1) > span.subject",
    linkSelector: "a:nth-child(1)",
    publishedSelector: "a:nth-child(1) > span.date",
    fields: { organization: text("a:nth-child(1) > span.org", "기관") },
    fieldSource: "llm",
  },
  read: readOf(
    [
      ["지역 소상공인 디지털 전환 지원 안내", "소상공인시장진흥공단"],
      ["2026년 정부 지원사업 통합 공고 안내", "중소벤처기업부"],
      ["창업 초기기업 멘토링 프로그램 참가자 모집", "창업진흥원"],
      ["청년 일자리 도약 장려금 신청 접수", "고용노동부"],
    ].map(([title, org]) => reportedItem(title, [reportedField("organization", org)])),
  ),
};

const NESTED_DIV: FixtureCase = {
  name: "클래스 없는 중첩 div",
  file: "nested-div",
  pageUrl: "https://www.example.kr/jobs",
  spec: {
    strategy: "html",
    itemSelector: "#list > div",
    titleSelector: "div:nth-child(1) > a:nth-child(1)",
    linkSelector: "div:nth-child(1) > a:nth-child(1)",
    fields: {
      company: text("div:nth-child(2) > span:nth-child(1)", "회사"),
      deadline: { selector: "div:nth-child(2) > span:nth-child(2)", label: "마감", type: "date", role: "deadline" },
    },
    fieldSource: "llm",
  },
  read: readOf(
    [
      ["백엔드 개발자 경력 채용 (서울 강남)", "주식회사 가나다", "~ 2026-04-30"],
      ["프론트엔드 개발자 신입 공개채용", "주식회사 라마바", "~ 2026-04-15"],
      ["데이터 엔지니어 수시 채용 (판교)", "주식회사 사아자", "~ 2026-05-10"],
    ].map(([title, company, deadline]) =>
      reportedItem(title, [reportedField("company", company), reportedField("deadline", deadline)]),
    ),
  ),
};

describe.each([TABLE_BOARD, CARD_GRID, UL_LIST, NESTED_DIV])("픽스처: $name", (fx) => {
  const html = loadFixture(fx.file);
  const { score } = verifySpec(html, fx.pageUrl, fx.spec, fx.read);

  it("정상 스펙은 모든 지표가 만점으로 통과한다", () => {
    expect(score.ok).toBe(true);
    expect(score.itemCount).toBe(fx.read.items.length);
    expect(score.matchedCount).toBe(fx.read.items.length);
    expect(score.reportedCount).toBe(fx.read.items.length);
    expect(score.rowYield).toBe(1);
    expect(score.titleMatchRate).toBe(1);
  });

  it("모든 필드의 채움률과 일치율이 1이라 pruneFailedFields가 아무것도 제거하지 않는다", () => {
    for (const [key, rate] of Object.entries(score.fieldRates)) {
      expect(rate, key).toEqual({ fill: 1, match: 1 });
    }
    expect(pruneFailedFields(fx.spec, score)).toEqual(fx.spec);
  });
});

describe("픽스처에서 셀렉터를 일부러 넓히면", () => {
  it("테이블 게시판: 헤더 행(th만 있음)까지 잡는 tr은 수율 0.8로 통과한다 — 제목이 없는 행은 건너뛴다", () => {
    const spec: CrawlSpec = { ...TABLE_BOARD.spec, itemSelector: "table.board-list tr" };
    const { score } = verifySpec(loadFixture("table-board"), TABLE_BOARD.pageUrl, spec, TABLE_BOARD.read);
    expect(score.matchedCount).toBe(5);
    expect(score.itemCount).toBe(4);
    expect(score.rowYield).toBe(0.8);
    expect(score.ok).toBe(true);
  });

  it("중첩 div: 앱 안의 모든 div를 잡으면 행이 되는 것이 7/18뿐이라 ok=false", () => {
    // titleSelector 없이 앵커 추측 경로만 쓴다. 제목 셀렉터가 있으면 아래 한계 테스트처럼 11/18까지 올라간다.
    const { titleSelector: _title, linkSelector: _link, ...rest } = NESTED_DIV.spec;
    const spec: CrawlSpec = { ...rest, itemSelector: "#app div" };
    const { score } = verifySpec(loadFixture("nested-div"), NESTED_DIV.pageUrl, spec, NESTED_DIV.read);
    expect(score.matchedCount).toBe(18);
    expect(score.itemCount).toBe(7);
    expect(score.rowYield).toBeCloseTo(7 / 18);
    expect(score.titleMatchRate).toBe(1);
    expect(score.ok).toBe(false);
  });

  // 아래 둘은 수율이 과포함을 못 잡는 경우를 있는 그대로 고정한 것이다. 고쳐야 할 동작이 아니라
  // 설계가 받아들인 한계다: 다른 목록의 항목도 제목 앵커를 가지면 행이 되어 버리고,
  // 보고 12건 대비 행이 많은 것은 정상 목록과 구별할 수 없다(설계서 §5-4).
  it("한계: 관련 링크 목록까지 잡는 li도 그 항목이 앵커를 가지면 수율 1로 통과한다", () => {
    const spec: CrawlSpec = { strategy: "html", itemSelector: "li", titleSelector: UL_LIST.spec.titleSelector, linkSelector: UL_LIST.spec.linkSelector };
    const { score } = verifySpec(loadFixture("ul-list"), UL_LIST.pageUrl, spec, UL_LIST.read);
    expect(score.itemCount).toBe(7);
    expect(score.reportedCount).toBe(4);
    expect(score.rowYield).toBe(1);
    expect(score.ok).toBe(true);
  });

  it("한계: 바깥 래퍼 div까지 잡아도 수율이 0.6을 넘으면 통과한다", () => {
    const spec: CrawlSpec = { ...NESTED_DIV.spec, itemSelector: "div" };
    const { score } = verifySpec(loadFixture("nested-div"), NESTED_DIV.pageUrl, spec, NESTED_DIV.read);
    expect(score.rowYield).toBeCloseTo(12 / 19);
    expect(score.ok).toBe(true);
  });
});
