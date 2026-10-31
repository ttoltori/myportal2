import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applySpec, SELF_TITLE_SELECTOR, type ExtractedRow } from "../extract";
import type { PageReadResult } from "./llm-read";
import { buildPageOutline, type PageOutline } from "./page-outline";
import { resolveItemRoots, synthesizeSpec } from "./selector-synthesis";

type ReadItem = PageReadResult["items"][number];
type ReadField = ReadItem["fields"][number];

const PAGE_URL = "https://www.example.kr/list";

const page = (body: string): string => `<html><body>${body}</body></html>`;

function loadFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}.html`, import.meta.url)), "utf-8");
}

function readOf(items: ReadItem[]): PageReadResult {
  return {
    pageKind: "list",
    pageTitle: "",
    items,
    suggested: { displayName: "", categoryPath: [], tagNames: [] },
  };
}

function field(key: string, ref: number, text: string, extra: Partial<ReadField> = {}): ReadField {
  return { key, label: key, type: "text", role: "none", ref, text, ...extra };
}

const fold = (s: string | null): string => (s ?? "").replace(/\s+/g, " ").trim();

// 인라인 HTML 테스트용: 번호를 손으로 세지 않고 개요에서 텍스트로 찾는다.
// 픽스처 4종은 이 도우미를 쓰지 않고 개요를 출력해 확인한 번호를 그대로 적는다.
function refOf(outline: PageOutline, text: string, nth = 0): number {
  const hits = outline.refs.flatMap((el, i) => (el && fold(el.tagName === "IMG" ? el.getAttribute("alt") : el.textContent) === text ? [i] : []));
  const ref = hits[nth];
  if (ref === undefined) throw new Error(`개요에 "${text}"가 없다`);
  return ref;
}

// 제목 앵커 + 기관 + 날짜를 가진 단순 목록. 인라인 테스트의 기본 재료다.
const SIMPLE_LIST = page(`
  <ul class="list">
    <li><a href="/a/1">첫 번째 공고 제목입니다</a><span class="org">기관 하나</span><span class="date">2026-01-01</span></li>
    <li><a href="/a/2">두 번째 공고 제목입니다</a><span class="org">기관 둘</span><span class="date">2026-01-02</span></li>
    <li><a href="/a/3">세 번째 공고 제목입니다</a><span class="org">기관 셋</span><span class="date">2026-01-03</span></li>
  </ul>
`);

const SIMPLE_TITLES = ["첫 번째 공고 제목입니다", "두 번째 공고 제목입니다", "세 번째 공고 제목입니다"];
const SIMPLE_ORGS = ["기관 하나", "기관 둘", "기관 셋"];

function simpleItems(outline: PageOutline, extraFields?: (i: number) => ReadField[]): ReadItem[] {
  return SIMPLE_TITLES.map((title, i) => ({
    titleRef: refOf(outline, title),
    titleText: title,
    fields: extraFields ? extraFields(i) : [field("organization", refOf(outline, SIMPLE_ORGS[i]), SIMPLE_ORGS[i])],
  }));
}

function synth(html: string, build: (outline: PageOutline) => ReadItem[]) {
  const outline = buildPageOutline(html);
  const result = synthesizeSpec(outline, readOf(build(outline)), PAGE_URL);
  return { outline, result };
}

// ── 픽스처 4종 ──
// 아래 read는 "LLM이 개요를 읽고 이렇게 답했을 것"을 손으로 쓴 것이다.
// ref 번호는 buildPageOutline이 출력한 개요에서 확인한 값이다.
// 개요 형식이 바뀌어 번호가 밀리면 dropped/remapped 단언이 먼저 깨진다.

interface FixtureCase {
  name: string;
  file: string;
  pageUrl: string;
  read: PageReadResult;
  itemSelector: string;
  expectedRows: Pick<ExtractedRow, "title" | "link" | "attrs">[];
  expectedPublished?: (string | null)[];
}

const TABLE_BOARD: FixtureCase = (() => {
  const rows = [
    { title: "2026년 AI 바우처 지원사업 공고", n: 4, ids: [10, 11, 12, 13, 14], org: "정보통신산업진흥원", period: "2026-01-05 ~ 2026-02-03", posted: "2025-12-20", id: 104 },
    { title: "데이터 활용 중소기업 모집 안내", n: 3, ids: [15, 16, 17, 18, 19], org: "한국데이터산업진흥원", period: "2025-12-01 ~ 2025-12-31", posted: "2025-11-25", id: 103 },
    { title: "스마트공장 구축 지원사업 참여기업 공모", n: 2, ids: [20, 21, 22, 23, 24], org: "중소벤처기업진흥공단", period: "2025-11-10 ~ 2025-11-30", posted: "2025-11-01", id: 102 },
    { title: "수출 바우처 사업 수행기관 추가 모집", n: 1, ids: [25, 26, 27, 28, 29], org: "대한무역투자진흥공사", period: "2025-10-01 ~ 2025-10-15", posted: "2025-09-25", id: 101 },
  ];
  return {
    name: "테이블 게시판",
    file: "table-board",
    pageUrl: "https://www.example.kr/notice/list.it",
    itemSelector: "table.board-list tbody > tr",
    read: readOf(
      rows.map((r) => ({
        titleRef: r.ids[1],
        titleText: r.title,
        linkRef: r.ids[1],
        fields: [
          field("no", r.ids[0], String(r.n), { label: "번호", type: "number" }),
          field("organization", r.ids[2], r.org, { label: "기관" }),
          field("apply_period", r.ids[3], r.period, { label: "접수기간", type: "date_range", role: "deadline" }),
          field("posted_at", r.ids[4], r.posted, { label: "등록일", type: "date", role: "published" }),
        ],
      })),
    ),
    expectedRows: rows.map((r) => ({
      title: r.title,
      link: `https://www.example.kr/notice/${r.id}?page=1`,
      attrs: { no: String(r.n), organization: r.org, apply_period: r.period },
    })),
    expectedPublished: rows.map((r) => new Date(r.posted).toISOString()),
  };
})();

const CARD_GRID: FixtureCase = (() => {
  const cards = [
    { id: 11, ref: 5, title: "청년 창업 아이디어 공모전", org: "주최: 창업진흥원", prize: "총 상금 5,000만원", dday: "D-3", desc: "청년 창업가를 발굴하기 위해 마련된 이번 공모전은 아이디어 단계의 팀도 참여할 수 있으며 우수 팀에는 사업화 자금이 지원됩니다" },
    { id: 12, ref: 12, title: "공공데이터 활용 경진대회", org: "주최: 행정안전부", prize: "총 상금 3,000만원", dday: "D-10", desc: "공공데이터를 활용한 서비스 아이디어와 개발 부문으로 나누어 접수하며 수상 팀에는 장관상과 상금이 수여됩니다" },
    { id: 13, ref: 19, title: "지역 관광 영상 공모전", org: "주최: 한국관광공사", prize: "총 상금 2,000만원", dday: "D-21", desc: "우리 지역의 숨은 관광지를 영상으로 소개하는 공모전으로 일반인과 학생 모두 참여할 수 있습니다" },
  ];
  // 카드 하나는 개요에서 [썸네일 앵커, img, 제목 앵커, 주최, 상금, 요약 앵커, D-day] 7줄이다.
  return {
    name: "카드 그리드",
    file: "card-grid",
    pageUrl: "https://www.example.kr/contest",
    itemSelector: "div.card",
    read: readOf(
      cards.map((c) => ({
        titleRef: c.ref + 2,
        titleText: c.title,
        linkRef: c.ref + 2,
        fields: [
          field("poster_url", c.ref, "", { label: "포스터 링크", type: "url" }),
          field("thumbnail", c.ref + 1, `${c.title} 포스터`, { label: "썸네일", type: "image" }),
          field("organizer", c.ref + 3, c.org, { label: "주최" }),
          field("prize", c.ref + 4, c.prize, { label: "상금" }),
          field("summary", c.ref + 5, c.desc, { label: "요약", role: "summary" }),
          field("d_day", c.ref + 6, c.dday, { label: "남은 기간", role: "deadline" }),
        ],
      })),
    ),
    expectedRows: cards.map((c) => ({
      title: c.title,
      // 카드에는 더 긴 요약 앵커(?tab=guide)가 있다. 링크는 제목 앵커여야 한다.
      link: `https://www.example.kr/c/${c.id}`,
      attrs: {
        poster_url: `https://www.example.kr/c/${c.id}`,
        thumbnail: `/img/${c.id}.jpg`,
        organizer: c.org,
        prize: c.prize,
        summary: c.desc,
        d_day: c.dday,
      },
    })),
  };
})();

const UL_LIST: FixtureCase = (() => {
  const lis = [
    { id: 301, ref: 3, title: "지역 소상공인 디지털 전환 지원 안내", org: "소상공인시장진흥공단", date: "2026-03-05" },
    { id: 300, ref: 7, title: "2026년 정부 지원사업 통합 공고 안내", org: "중소벤처기업부", date: "2026-03-02" },
    { id: 299, ref: 11, title: "창업 초기기업 멘토링 프로그램 참가자 모집", org: "창업진흥원", date: "2026-02-27" },
    { id: 298, ref: 15, title: "청년 일자리 도약 장려금 신청 접수", org: "고용노동부", date: "2026-02-20" },
  ];
  // 제목 span이 앵커 안쪽이다. linkRef 없이도 span의 조상 앵커가 링크가 되어야 한다.
  return {
    name: "ul>li (앵커 안쪽 span)",
    file: "ul-list",
    pageUrl: "https://www.example.kr/news",
    itemSelector: "li.item",
    read: readOf(
      lis.map((l) => ({
        titleRef: l.ref,
        titleText: l.title,
        fields: [
          field("organization", l.ref + 1, l.org, { label: "기관" }),
          field("posted_at", l.ref + 2, l.date, { label: "게시일", type: "date", role: "published" }),
        ],
      })),
    ),
    expectedRows: lis.map((l) => ({
      title: l.title,
      link: `https://www.example.kr/news/${l.id}`,
      attrs: { organization: l.org },
    })),
    expectedPublished: lis.map((l) => new Date(l.date).toISOString()),
  };
})();

const NESTED_DIV: FixtureCase = (() => {
  const jobs = [
    { id: 901, ref: 5, title: "백엔드 개발자 경력 채용 (서울 강남)", company: "주식회사 가나다", deadline: "~ 2026-04-30" },
    { id: 902, ref: 8, title: "프론트엔드 개발자 신입 공개채용", company: "주식회사 라마바", deadline: "~ 2026-04-15" },
    { id: 903, ref: 11, title: "데이터 엔지니어 수시 채용 (판교)", company: "주식회사 사아자", deadline: "~ 2026-05-10" },
  ];
  return {
    name: "클래스 없는 중첩 div",
    file: "nested-div",
    pageUrl: "https://www.example.kr/jobs",
    itemSelector: "#list > div",
    read: readOf(
      jobs.map((j) => ({
        titleRef: j.ref,
        titleText: j.title,
        linkRef: j.ref,
        fields: [
          field("company", j.ref + 1, j.company, { label: "회사" }),
          field("deadline", j.ref + 2, j.deadline, { label: "마감", type: "date", role: "deadline" }),
        ],
      })),
    ),
    expectedRows: jobs.map((j) => ({
      title: j.title,
      link: `https://www.example.kr/jobs/${j.id}`,
      attrs: { company: j.company, deadline: j.deadline },
    })),
  };
})();

const FIXTURES = [TABLE_BOARD, CARD_GRID, UL_LIST, NESTED_DIV];

describe.each(FIXTURES)("픽스처: $name", (fx) => {
  const html = loadFixture(fx.file);
  const outline = buildPageOutline(html);
  const result = synthesizeSpec(outline, fx.read, fx.pageUrl);

  it("ref가 개요와 어긋나지 않아 버리거나 복구한 것이 없다", () => {
    expect(result).not.toBeNull();
    expect(result?.dropped).toEqual([]);
    expect(result?.remapped).toBe(0);
  });

  it("itemSelector가 모든 항목 루트를 포함한다", () => {
    const spec = result!.spec;
    expect(spec.itemSelector).toBe(fx.itemSelector);
    const matched = [...outline.document.querySelectorAll(spec.itemSelector!)];
    expect(matched).toHaveLength(fx.read.items.length);
    for (const item of fx.read.items) {
      const title = outline.refs[item.titleRef]!;
      expect(matched.some((root) => root.contains(title))).toBe(true);
    }
  });

  it("제목·링크 상대 셀렉터가 항목마다 보고한 요소에 닿는다", () => {
    const spec = result!.spec;
    const matched = [...outline.document.querySelectorAll(spec.itemSelector!)];
    fx.read.items.forEach((item, i) => {
      expect(matched[i].querySelector(spec.titleSelector!)).toBe(outline.refs[item.titleRef]);
      expect(matched[i].querySelector(spec.linkSelector!)?.getAttribute("href")).toMatch(/^[/?]/);
    });
  });

  it("applySpec으로 돌리면 LLM이 보고한 값이 title/link/attrs에 들어온다", () => {
    const rows = applySpec(html, result!.spec, fx.pageUrl);
    expect(rows.map(({ title, link, attrs }) => ({ title, link, attrs }))).toEqual(fx.expectedRows);
    if (fx.expectedPublished) expect(rows.map((r) => r.publishedAt)).toEqual(fx.expectedPublished);
  });

  it("spec.fields에는 고정 역할(title/link/published)이 없고 출처가 llm이다", () => {
    const spec = result!.spec;
    expect(spec.strategy).toBe("html");
    expect(spec.fieldSource).toBe("llm");
    for (const key of ["title", "link", "published", "posted_at"]) expect(spec.fields).not.toHaveProperty(key);
  });
});

describe("픽스처별 합성 결과 (이후 태스크가 의존하는 모양)", () => {
  const specOf = (fx: FixtureCase) => synthesizeSpec(buildPageOutline(loadFixture(fx.file)), fx.read, fx.pageUrl)!.spec;

  it("테이블 게시판", () => {
    const spec = specOf(TABLE_BOARD);
    expect(spec.titleSelector).toBe("td.subject > a:nth-child(1)");
    expect(spec.linkSelector).toBe("td.subject > a:nth-child(1)");
    expect(spec.publishedSelector).toBe("td:nth-child(5) > time:nth-child(1)");
    expect(spec.fields).toEqual({
      no: { selector: "td:nth-child(1)", label: "번호", type: "number", role: "none" },
      organization: { selector: "td:nth-child(3)", label: "기관", type: "text", role: "none" },
      apply_period: { selector: "td:nth-child(4)", label: "접수기간", type: "date_range", role: "deadline" },
    });
  });

  it("카드 그리드: 이미지는 src, 링크 필드는 href", () => {
    const spec = specOf(CARD_GRID);
    expect(spec.titleSelector).toBe("div.body > h3.tit > a:nth-child(1)");
    expect(spec.linkSelector).toBe("div.body > h3.tit > a:nth-child(1)");
    expect(spec.fields?.thumbnail).toMatchObject({ selector: "a.thumb > img:nth-child(1)", attr: "src" });
    expect(spec.fields?.poster_url).toMatchObject({ selector: "a.thumb", attr: "href" });
  });

  it("ul>li: 링크는 제목 span의 조상 앵커에서 만든다", () => {
    const spec = specOf(UL_LIST);
    expect(spec.titleSelector).toBe("a:nth-child(1) > span.subject");
    expect(spec.linkSelector).toBe("a:nth-child(1)");
    expect(spec.publishedSelector).toBe("a:nth-child(1) > span.date");
  });

  it("중첩 div: 클래스가 없어 nth-child 경로를 쓴다", () => {
    const spec = specOf(NESTED_DIV);
    expect(spec.titleSelector).toBe("div:nth-child(1) > a:nth-child(1)");
    expect(spec.fields?.company?.selector).toBe("div:nth-child(2) > span:nth-child(1)");
    expect(spec.fields?.deadline?.selector).toBe("div:nth-child(2) > span:nth-child(2)");
  });
});

describe("ref 해소 (Review Focus 2)", () => {
  it("범위 밖 ref를 가진 필드를 버리고 나머지로 합성한다", () => {
    const { result } = synth(SIMPLE_LIST, (o) =>
      simpleItems(o, (i) => [
        field("organization", refOf(o, SIMPLE_ORGS[i]), SIMPLE_ORGS[i]),
        field("ghost", 9999, "없는 값"),
      ]),
    );

    expect(result?.spec.fields).toHaveProperty("organization");
    expect(result?.spec.fields).not.toHaveProperty("ghost");
    expect(result?.dropped).toEqual([{ key: "ghost", reason: expect.stringContaining("범위 밖") }]);
  });

  it("한 항목에서만 범위 밖이면 나머지 항목으로 같은 key를 합성한다", () => {
    const { result } = synth(SIMPLE_LIST, (o) =>
      simpleItems(o, (i) => [field("organization", i === 0 ? 9999 : refOf(o, SIMPLE_ORGS[i]), SIMPLE_ORGS[i])]),
    );

    expect(result?.spec.fields?.organization?.selector).toBe("span.org");
    expect(result?.dropped).toHaveLength(1);
    const rows = applySpec(SIMPLE_LIST, result!.spec, PAGE_URL);
    expect(rows.map((r) => r.attrs.organization)).toEqual(SIMPLE_ORGS);
  });

  it("모든 항목의 titleRef가 범위 밖이면 null을 반환한다", () => {
    const { result } = synth(SIMPLE_LIST, () =>
      SIMPLE_TITLES.map((t, i) => ({ titleRef: 9000 + i, titleText: t, fields: [] })),
    );
    expect(result).toBeNull();
  });

  it("해소된 제목이 1개뿐이면 null을 반환한다", () => {
    const { result } = synth(SIMPLE_LIST, (o) => [
      { titleRef: refOf(o, SIMPLE_TITLES[0]), titleText: SIMPLE_TITLES[0], fields: [] },
      { titleRef: 9999, titleText: SIMPLE_TITLES[1], fields: [] },
    ]);
    expect(result).toBeNull();
  });

  it("항목이 하나만 보고되면 null을 반환한다", () => {
    const { result } = synth(SIMPLE_LIST, (o) => simpleItems(o).slice(0, 1));
    expect(result).toBeNull();
  });
});

describe("ref 어긋남 복구", () => {
  it("ref 노드 텍스트가 LLM이 적은 값과 다르면 값으로 재탐색하고 remapped를 센다", () => {
    // 첫 항목의 기관을 한 칸 밀려 날짜 span(ref)으로 가리켰다. 텍스트는 기관 값이다.
    const { result } = synth(SIMPLE_LIST, (o) =>
      simpleItems(o, (i) => [
        field("organization", i === 0 ? refOf(o, "2026-01-01") : refOf(o, SIMPLE_ORGS[i]), SIMPLE_ORGS[i]),
      ]),
    );

    expect(result?.remapped).toBe(1);
    expect(result?.dropped).toEqual([]);
    const rows = applySpec(SIMPLE_LIST, result!.spec, PAGE_URL);
    expect(rows.map((r) => r.attrs.organization)).toEqual(SIMPLE_ORGS);
  });

  it("제목 ref가 밀려도 titleText로 제목 요소를 되찾는다", () => {
    const { result } = synth(SIMPLE_LIST, (o) =>
      SIMPLE_TITLES.map((title, i) => ({
        titleRef: i === 1 ? refOf(o, SIMPLE_ORGS[1]) : refOf(o, title),
        titleText: title,
        fields: [],
      })),
    );

    expect(result?.remapped).toBe(1);
    expect(applySpec(SIMPLE_LIST, result!.spec, PAGE_URL).map((r) => r.title)).toEqual(SIMPLE_TITLES);
  });

  it("같은 값이 여러 곳에 있으면 원래 ref에 가장 가까운 것으로 복구한다", () => {
    const html = page(`
      <ul class="list">
        <li><a href="/a/1">첫 번째 공고 제목입니다</a><span class="st">접수중</span><span class="x">비고 하나</span></li>
        <li><a href="/a/2">두 번째 공고 제목입니다</a><span class="st">접수중</span><span class="x">비고 둘</span></li>
        <li><a href="/a/3">세 번째 공고 제목입니다</a><span class="st">접수중</span><span class="x">비고 셋</span></li>
      </ul>`);
    const { result } = synth(html, (o) =>
      SIMPLE_TITLES.map((title, i) => ({
        titleRef: refOf(o, title),
        titleText: title,
        // 세 번째 항목만 비고(.x)를 가리켰지만 텍스트는 "접수중"이다. 같은 항목의 .st로 가야 한다.
        fields: [field("status", i === 2 ? refOf(o, "비고 셋") : refOf(o, "접수중", i), "접수중")],
      })),
    );

    expect(result?.remapped).toBe(1);
    expect(result?.spec.fields?.status?.selector).toBe("span.st");
  });

  it("값으로도 못 찾으면 그 필드를 버린다", () => {
    const { result } = synth(SIMPLE_LIST, (o) =>
      simpleItems(o, () => [field("organization", refOf(o, SIMPLE_ORGS[0]), "문서 어디에도 없는 값")]),
    );

    expect(result?.remapped).toBe(0);
    expect(result?.spec.fields).toEqual({});
    expect(result?.dropped).toEqual([{ key: "organization", reason: expect.stringContaining("찾지 못했다") }]);
  });
});

describe("중복 필드 (Review Focus 3)", () => {
  it("같은 ref를 가리키는 중복 필드는 첫 번째만 채택하고 사유를 남긴다", () => {
    const { result } = synth(SIMPLE_LIST, (o) =>
      simpleItems(o, (i) => {
        const ref = refOf(o, SIMPLE_ORGS[i]);
        return [field("organization", ref, SIMPLE_ORGS[i]), field("agency", ref, SIMPLE_ORGS[i])];
      }),
    );

    expect(Object.keys(result!.spec.fields!)).toEqual(["organization"]);
    expect(result?.dropped).toEqual([{ key: "agency", reason: expect.stringContaining("첫 번째만 채택") }]);
  });

  it("제목과 같은 노드를 가리키는 필드는 버린다", () => {
    const { result } = synth(SIMPLE_LIST, (o) =>
      simpleItems(o, (i) => [field("name", refOf(o, SIMPLE_TITLES[i]), SIMPLE_TITLES[i])]),
    );

    expect(result?.spec.fields).toEqual({});
    expect(result?.dropped[0]).toMatchObject({ key: "name", reason: expect.stringContaining("title") });
  });

  it("한 항목 안에서 key가 겹치면 첫 번째만 채택한다", () => {
    const { result } = synth(SIMPLE_LIST, (o) =>
      simpleItems(o, (i) => [
        field("organization", refOf(o, SIMPLE_ORGS[i]), SIMPLE_ORGS[i]),
        field("organization", refOf(o, `2026-01-0${i + 1}`), `2026-01-0${i + 1}`),
      ]),
    );

    expect(result?.spec.fields?.organization?.selector).toBe("span.org");
    expect(result?.dropped).toEqual([{ key: "organization", reason: expect.stringContaining("key가 중복") }]);
  });
});

describe("항목 루트 (Review Focus 5)", () => {
  it("제목 요소들이 같은 부모를 공유해 조상이 갈라지지 않으면 null을 반환한다", () => {
    const html = page(`<div class="box"><a href="/a/1">첫 번째 공고 제목입니다</a><a href="/a/2">두 번째 공고 제목입니다</a></div>`);
    const { result } = synth(html, (o) => [
      { titleRef: refOf(o, SIMPLE_TITLES[0]), titleText: SIMPLE_TITLES[0], fields: [] },
      { titleRef: refOf(o, SIMPLE_TITLES[1]), titleText: SIMPLE_TITLES[1], fields: [] },
    ]);
    expect(result).toBeNull();
  });

  it("같은 요소를 두 항목의 제목으로 보고하면 null을 반환한다", () => {
    const { result } = synth(SIMPLE_LIST, (o) => {
      const ref = refOf(o, SIMPLE_TITLES[0]);
      return [
        { titleRef: ref, titleText: SIMPLE_TITLES[0], fields: [] },
        { titleRef: ref, titleText: SIMPLE_TITLES[0], fields: [] },
      ];
    });
    expect(result).toBeNull();
  });

  it("제목이 항목 루트 자신(공통 조상의 직계)이면 null을 반환한다", () => {
    const html = page(`<ul><li class="x">첫 번째 공고 제목입니다</li><li class="x">두 번째 공고 제목입니다</li></ul>`);
    const { result } = synth(html, (o) => [
      { titleRef: refOf(o, SIMPLE_TITLES[0]), titleText: SIMPLE_TITLES[0], fields: [] },
      { titleRef: refOf(o, SIMPLE_TITLES[1]), titleText: SIMPLE_TITLES[1], fields: [] },
    ]);
    expect(result).toBeNull();
  });

  it("세 번째 제목이 앞 항목과 같은 항목 안에 있으면 null을 반환한다", () => {
    const html = page(`
      <ul class="list">
        <li><a href="/a/1">첫 번째 공고 제목입니다</a><b><a href="/a/1b">첫 번째 공고 부제목입니다</a></b></li>
        <li><a href="/a/2">두 번째 공고 제목입니다</a></li>
      </ul>`);
    const { result } = synth(html, (o) => [
      { titleRef: refOf(o, SIMPLE_TITLES[0]), titleText: SIMPLE_TITLES[0], fields: [] },
      { titleRef: refOf(o, SIMPLE_TITLES[1]), titleText: SIMPLE_TITLES[1], fields: [] },
      { titleRef: refOf(o, "첫 번째 공고 부제목입니다"), titleText: "첫 번째 공고 부제목입니다", fields: [] },
    ]);
    expect(result).toBeNull();
  });

  it("네 번째 이후 제목이 목록 밖이면 그 항목만 제외하고 합성한다", () => {
    const html = page(`
      <ul class="list">
        <li><a href="/a/1">첫 번째 공고 제목입니다</a></li>
        <li><a href="/a/2">두 번째 공고 제목입니다</a></li>
        <li><a href="/a/3">세 번째 공고 제목입니다</a></li>
      </ul>
      <p class="stray"><a href="/z">목록 밖에 있는 링크 문구입니다</a></p>`);
    const { result } = synth(html, (o) =>
      [...SIMPLE_TITLES, "목록 밖에 있는 링크 문구입니다"].map((t) => ({ titleRef: refOf(o, t), titleText: t, fields: [] })),
    );

    expect(result?.dropped).toEqual([{ key: "items[3]", reason: expect.stringContaining("항목 루트") }]);
    expect(applySpec(html, result!.spec, PAGE_URL).map((r) => r.title)).toEqual(SIMPLE_TITLES);
  });

  it("행으로 감싼 그리드의 다른 행 카드도 같은 높이의 조상을 루트로 쓴다", () => {
    const card = (n: number) => `<div class="card"><h3><a href="/c/${n}">카드 제목 ${n}번</a></h3><p class="org">주최 ${n}</p></div>`;
    const html = page(`<div class="grid">
      <div class="row">${card(1)}${card(2)}</div>
      <div class="row">${card(3)}${card(4)}</div>
      <div class="row">${card(5)}</div></div>`);
    const { result } = synth(html, (o) =>
      [1, 2, 3, 4, 5].map((n) => ({
        titleRef: refOf(o, `카드 제목 ${n}번`),
        titleText: `카드 제목 ${n}번`,
        fields: [field("organizer", refOf(o, `주최 ${n}`), `주최 ${n}`)],
      })),
    );

    expect(result?.spec.itemSelector).toBe("div.card");
    const rows = applySpec(html, result!.spec, PAGE_URL);
    expect(rows.map((r) => r.title)).toEqual([1, 2, 3, 4, 5].map((n) => `카드 제목 ${n}번`));
    expect(rows.map((r) => r.attrs.organizer)).toEqual([1, 2, 3, 4, 5].map((n) => `주최 ${n}`));
  });

  it("resolveItemRoots: 제목이 하나뿐이면 null", () => {
    const outline = buildPageOutline(SIMPLE_LIST);
    expect(resolveItemRoots([outline.refs[refOf(outline, SIMPLE_TITLES[0])]!])).toBeNull();
  });
});

describe("고정 역할", () => {
  it("key가 title/link/published인 필드를 버린다", () => {
    const { result } = synth(SIMPLE_LIST, (o) =>
      simpleItems(o, (i) => [
        field("title", refOf(o, SIMPLE_ORGS[i]), SIMPLE_ORGS[i]),
        field("link", refOf(o, SIMPLE_ORGS[i]), SIMPLE_ORGS[i]),
        field("published", refOf(o, `2026-01-0${i + 1}`), `2026-01-0${i + 1}`),
      ]),
    );

    expect(result?.spec.fields).toEqual({});
    expect(result?.spec.publishedSelector).toBeUndefined();
    expect(result?.dropped.map((d) => d.key).sort()).toEqual(["link", "published", "title"]);
  });

  it("role이 title/link인 필드를 버린다", () => {
    const { result } = synth(SIMPLE_LIST, (o) =>
      simpleItems(o, (i) => [
        field("headline", refOf(o, SIMPLE_ORGS[i]), SIMPLE_ORGS[i], { role: "title" }),
        field("url", refOf(o, SIMPLE_ORGS[i]), SIMPLE_ORGS[i], { role: "link" }),
      ]),
    );

    expect(result?.spec.fields).toEqual({});
    expect(result?.dropped.map((d) => d.key).sort()).toEqual(["headline", "url"]);
  });

  it("role이 published인 필드는 fields에서 빼고 publishedSelector로 승격한다", () => {
    const { result } = synth(SIMPLE_LIST, (o) =>
      simpleItems(o, (i) => [
        field("posted_at", refOf(o, `2026-01-0${i + 1}`), `2026-01-0${i + 1}`, { type: "date", role: "published" }),
      ]),
    );

    expect(result?.spec.fields).toEqual({});
    expect(result?.spec.publishedSelector).toBe("span.date");
    expect(result?.dropped).toEqual([]);
  });

  it("게시일 필드가 둘이면 먼저 보고된 것만 쓴다", () => {
    const { result } = synth(SIMPLE_LIST, (o) =>
      simpleItems(o, (i) => [
        field("posted_at", refOf(o, `2026-01-0${i + 1}`), `2026-01-0${i + 1}`, { role: "published" }),
        field("updated_at", refOf(o, SIMPLE_ORGS[i]), SIMPLE_ORGS[i], { role: "published" }),
      ]),
    );

    expect(result?.spec.publishedSelector).toBe("span.date");
    expect(result?.dropped).toEqual([{ key: "updated_at", reason: expect.stringContaining("하나만") }]);
  });

  it("제목·링크·게시일은 titleSelector/linkSelector/publishedSelector로 분리한다", () => {
    const { result } = synth(SIMPLE_LIST, (o) =>
      simpleItems(o, (i) => [
        field("posted_at", refOf(o, `2026-01-0${i + 1}`), `2026-01-0${i + 1}`, { role: "published" }),
      ]),
    );

    expect(result?.spec).toMatchObject({
      titleSelector: "a:nth-child(1)",
      linkSelector: "a:nth-child(1)",
      publishedSelector: "span.date",
    });
    const rows = applySpec(SIMPLE_LIST, result!.spec, PAGE_URL);
    expect(rows.map((r) => r.publishedAt)).toEqual(["2026-01-01", "2026-01-02", "2026-01-03"].map((d) => new Date(d).toISOString()));
  });
});

describe("링크 (제목과 항상 함께)", () => {
  it("linkRef가 없으면 제목 요소의 조상 앵커로 linkSelector를 만든다", () => {
    const { result } = synth(SIMPLE_LIST, (o) => simpleItems(o));
    expect(result?.spec.linkSelector).toBe("a:nth-child(1)");
    expect(applySpec(SIMPLE_LIST, result!.spec, PAGE_URL).map((r) => r.link)).toEqual([
      "https://www.example.kr/a/1",
      "https://www.example.kr/a/2",
      "https://www.example.kr/a/3",
    ]);
  });

  it("제목이 앵커 안쪽 span이고 안에 더 긴 앵커가 있어도 링크는 제목의 앵커다", () => {
    const html = page(`
      <ul class="list">
        <li><a href="/t/1"><span class="t">짧은 제목 하나</span></a><a href="/s/1">이것은 훨씬 더 길게 쓰인 요약 문장 앵커입니다 하나</a></li>
        <li><a href="/t/2"><span class="t">짧은 제목 둘</span></a><a href="/s/2">이것은 훨씬 더 길게 쓰인 요약 문장 앵커입니다 둘</a></li>
      </ul>`);
    const { result } = synth(html, (o) =>
      ["짧은 제목 하나", "짧은 제목 둘"].map((t) => ({ titleRef: refOf(o, t), titleText: t, fields: [] })),
    );

    expect(applySpec(html, result!.spec, PAGE_URL).map((r) => r.link)).toEqual([
      "https://www.example.kr/t/1",
      "https://www.example.kr/t/2",
    ]);
  });

  it("linkRef가 앵커 안쪽 요소를 가리켜도 그 조상 앵커를 쓴다", () => {
    const html = page(`
      <ul class="list">
        <li><span class="t">제목 하나</span><a href="/d/1"><b>자세히</b></a></li>
        <li><span class="t">제목 둘</span><a href="/d/2"><b>자세히</b></a></li>
      </ul>`);
    const { result } = synth(html, (o) =>
      ["제목 하나", "제목 둘"].map((t, i) => ({
        titleRef: refOf(o, t),
        titleText: t,
        linkRef: refOf(o, "자세히", i),
        fields: [],
      })),
    );

    expect(result?.spec.linkSelector).toBe("a:nth-child(2)");
    expect(applySpec(html, result!.spec, PAGE_URL).map((r) => r.link)).toEqual([
      "https://www.example.kr/d/1",
      "https://www.example.kr/d/2",
    ]);
  });

  it("제목 주변에 앵커가 없으면 titleSelector만 두고 사유를 남긴다", () => {
    const html = page(`
      <ul class="list">
        <li><span class="t">앵커 없는 제목 하나</span></li>
        <li><span class="t">앵커 없는 제목 둘</span></li>
      </ul>`);
    const { result } = synth(html, (o) =>
      ["앵커 없는 제목 하나", "앵커 없는 제목 둘"].map((t) => ({ titleRef: refOf(o, t), titleText: t, fields: [] })),
    );

    expect(result?.spec.titleSelector).toBe("span.t");
    expect(result?.spec.linkSelector).toBeUndefined();
    expect(result?.dropped).toEqual([{ key: "link", reason: expect.stringContaining("a[href]") }]);
  });

  it("앵커 href를 절대화할 수 없으면(javascript:) linkSelector를 두지 않는다", () => {
    const html = page(`
      <ul class="list">
        <li><a href="javascript:view(1)">자바스크립트 링크 하나</a></li>
        <li><a href="javascript:view(2)">자바스크립트 링크 둘</a></li>
      </ul>`);
    const { result } = synth(html, (o) =>
      ["자바스크립트 링크 하나", "자바스크립트 링크 둘"].map((t) => ({ titleRef: refOf(o, t), titleText: t, fields: [] })),
    );

    expect(result?.spec.linkSelector).toBeUndefined();
    expect(result?.dropped.map((d) => d.key)).toEqual(["link"]);
  });

  it("항목 루트가 앵커 자신이면 linkSelector를 두지 못하고 사유를 남긴다", () => {
    const html = page(`
      <div class="grid">
        <a class="card" href="/c/1"><h3>카드 전체가 링크 하나</h3><p>설명</p></a>
        <a class="card" href="/c/2"><h3>카드 전체가 링크 둘</h3><p>설명</p></a>
      </div>`);
    const { result } = synth(html, (o) =>
      ["카드 전체가 링크 하나", "카드 전체가 링크 둘"].map((t) => ({ titleRef: refOf(o, t), titleText: t, fields: [] })),
    );

    expect(result?.spec.itemSelector).toBe("a.card");
    expect(result?.spec.titleSelector).toBe("h3:nth-child(1)");
    expect(result?.spec.linkSelector).toBeUndefined();
    expect(result?.dropped.map((d) => d.key)).toEqual(["link"]);
    // 앵커가 항목 자신이면 applyDomSpec이 항목 속성의 href로 링크를 복원한다.
    expect(applySpec(html, result!.spec, PAGE_URL).map((r) => r.link)).toEqual([
      "https://www.example.kr/c/1",
      "https://www.example.kr/c/2",
    ]);
  });
});

describe("값 추출 방식", () => {
  const html = page(`
    <ul class="list">
      <li><a href="/a/1">첫 번째 공고 제목입니다</a><a class="more" href="/more/1"><span>상세 보기 하나</span></a><img class="th" src="/i/1.png" alt="썸네일 하나"><time datetime="2026-02-01T09:00:00+09:00">2월 1일</time></li>
      <li><a href="/a/2">두 번째 공고 제목입니다</a><a class="more" href="/more/2"><span>상세 보기 둘</span></a><img class="th" src="/i/2.png" alt="썸네일 둘"><time datetime="2026-02-02T09:00:00+09:00">2월 2일</time></li>
    </ul>`);
  const build = (o: PageOutline): ReadItem[] =>
    SIMPLE_TITLES.slice(0, 2).map((title, i) => ({
      titleRef: refOf(o, title),
      titleText: title,
      fields: [
        field("more_url", refOf(o, ["상세 보기 하나", "상세 보기 둘"][i]), ["상세 보기 하나", "상세 보기 둘"][i], { type: "url" }),
        field("thumb", refOf(o, ["썸네일 하나", "썸네일 둘"][i], 0), ["썸네일 하나", "썸네일 둘"][i], { type: "image" }),
        field("when", refOf(o, ["2월 1일", "2월 2일"][i]), ["2월 1일", "2월 2일"][i], { type: "date" }),
      ],
    }));

  it("앵커이고 type=url이면 attr=href를 붙인다 (안쪽 span을 가리켜도 앵커로 옮긴다)", () => {
    const { result } = synth(html, build);
    expect(result?.spec.fields?.more_url).toMatchObject({ selector: "a.more", attr: "href" });
  });

  it("img이면 attr=src를 붙인다", () => {
    const { result } = synth(html, build);
    expect(result?.spec.fields?.thumb).toMatchObject({ selector: "img.th", attr: "src" });
  });

  it("time[datetime]이면 attr=datetime을 붙인다", () => {
    const { result } = synth(html, build);
    expect(result?.spec.fields?.when).toMatchObject({ selector: "time:nth-child(4)", attr: "datetime" });
  });

  it("그 외는 텍스트라 attr이 없다", () => {
    const { result } = synth(SIMPLE_LIST, (o) => simpleItems(o));
    expect(result?.spec.fields?.organization).not.toHaveProperty("attr");
  });

  it("지연 로딩 img는 data-src를 쓴다", () => {
    const lazy = page(`
      <ul class="list">
        <li><a href="/a/1">첫 번째 공고 제목입니다</a><img class="th" src="/blank.gif" data-src="/real/1.png" alt="실제 이미지 하나"></li>
        <li><a href="/a/2">두 번째 공고 제목입니다</a><img class="th" src="/blank.gif" data-src="/real/2.png" alt="실제 이미지 둘"></li>
      </ul>`);
    const { result } = synth(lazy, (o) =>
      SIMPLE_TITLES.slice(0, 2).map((title, i) => ({
        titleRef: refOf(o, title),
        titleText: title,
        fields: [field("thumb", refOf(o, ["실제 이미지 하나", "실제 이미지 둘"][i]), ["실제 이미지 하나", "실제 이미지 둘"][i], { type: "image" })],
      })),
    );
    expect(result?.spec.fields?.thumb.attr).toBe("data-src");
    expect(applySpec(lazy, result!.spec, PAGE_URL).map((r) => r.attrs.thumb)).toEqual(["/real/1.png", "/real/2.png"]);
  });

  it("type=url인데 항목 안에 앵커가 없으면 필드를 버린다", () => {
    const { result } = synth(SIMPLE_LIST, (o) =>
      simpleItems(o, (i) => [field("site", refOf(o, SIMPLE_ORGS[i]), SIMPLE_ORGS[i], { type: "url" })]),
    );
    expect(result?.spec.fields).toEqual({});
    expect(result?.dropped).toEqual([{ key: "site", reason: expect.stringContaining("a[href]") }]);
  });
});

describe("상대 셀렉터 일반화", () => {
  it("항목마다 첫 클래스가 달라 경로가 다르면 공통 접미로 줄인다", () => {
    const html = page(`
      <ul class="list">
        <li><a href="/a/1">첫 번째 공고 제목입니다</a><div class="on meta"><span class="date">2026-01-01</span></div></li>
        <li><a href="/a/2">두 번째 공고 제목입니다</a><div class="meta"><span class="date">2026-01-02</span></div></li>
        <li><a href="/a/3">세 번째 공고 제목입니다</a><div class="off meta"><span class="date">2026-01-03</span></div></li>
      </ul>`);
    const { result } = synth(html, (o) =>
      simpleItems(o, (i) => [field("posted_at", refOf(o, `2026-01-0${i + 1}`), `2026-01-0${i + 1}`, { role: "published" })]),
    );

    expect(result?.spec.publishedSelector).toBe("span.date");
    expect(applySpec(html, result!.spec, PAGE_URL).map((r) => r.publishedAt)).toEqual(
      ["2026-01-01", "2026-01-02", "2026-01-03"].map((d) => new Date(d).toISOString()),
    );
  });

  it("공통 접미가 없으면 그 필드를 버린다", () => {
    const html = page(`
      <ul class="list">
        <li><a href="/a/1">첫 번째 공고 제목입니다</a><b class="x">값 하나</b></li>
        <li><a href="/a/2">두 번째 공고 제목입니다</a><i class="y">값 둘</i></li>
      </ul>`);
    const { result } = synth(html, (o) =>
      ["값 하나", "값 둘"].map((v, i) => ({
        titleRef: refOf(o, SIMPLE_TITLES[i]),
        titleText: SIMPLE_TITLES[i],
        fields: [field("v", refOf(o, v), v)],
      })),
    );

    expect(result?.spec.fields).toEqual({});
    expect(result?.dropped).toEqual([{ key: "v", reason: expect.stringContaining("공통 상대 셀렉터") }]);
  });

  const TWO_ROW_TABLE = page(`
    <table><tbody>
      <tr><td><a href="/a/1">첫 번째 공고 제목입니다</a></td><td class="o">기관 하나</td></tr>
      <tr><td><a href="/a/2">두 번째 공고 제목입니다</a></td><td class="o">기관 둘</td></tr>
    </tbody></table>`);

  it("필드 요소가 일부 항목의 루트 밖이면 그 항목 샘플만 건너뛰고 나머지로 셀렉터를 만든다", () => {
    const { result } = synth(TWO_ROW_TABLE, (o) =>
      SIMPLE_TITLES.slice(0, 2).map((title) => ({
        titleRef: refOf(o, title),
        titleText: title,
        // 첫 항목의 기관을 둘째 항목의 노드로 잘못 가리켰다(텍스트도 둘째 값이라 복구 대상이 아니다).
        fields: [field("organization", refOf(o, "기관 둘"), "기관 둘")],
      })),
    );

    // 첫 항목의 샘플은 쓰이지 않았다: 어긋난 요소는 첫 항목 루트에서 상대 셀렉터가 만들어지지 않는다.
    expect(result?.spec.fields?.organization?.selector).toBe("td.o");
    expect(result?.dropped).toEqual([]);
    // 셀렉터는 항목 기준이라 첫 항목은 자기 칸의 값을 읽는다.
    expect(applySpec(TWO_ROW_TABLE, result!.spec, PAGE_URL).map((r) => r.attrs.organization)).toEqual(["기관 하나", "기관 둘"]);
  });

  it("모든 항목의 필드 요소가 자기 루트 밖이면 필드를 버리고 사유를 남긴다", () => {
    const { result } = synth(TWO_ROW_TABLE, (o) =>
      SIMPLE_TITLES.slice(0, 2).map((title, i) => ({
        titleRef: refOf(o, title),
        titleText: title,
        // 항목 0은 항목 1의 칸을, 항목 1은 항목 0의 칸을 가리킨다.
        fields: [field("organization", refOf(o, ["기관 둘", "기관 하나"][i]), ["기관 둘", "기관 하나"][i])],
      })),
    );

    expect(result?.spec.fields).toEqual({});
    expect(result?.dropped).toEqual([{ key: "organization", reason: expect.stringContaining("공통 상대 셀렉터") }]);
  });
});

describe("itemSelector 과포함", () => {
  const titleItems = (o: PageOutline): ReadItem[] =>
    SIMPLE_TITLES.map((t) => ({ titleRef: refOf(o, t), titleText: t, fields: [] }));

  it("공통 조상 밖의 같은 클래스 요소(사이드바)는 조상을 접두로 붙여 걸러낸다", () => {
    const html = page(`
      <div class="rail"><ul>
        <li class="it"><a href="/o/1">목록이 아닌 반복 요소 하나</a></li>
        <li class="it"><a href="/o/2">목록이 아닌 반복 요소 둘</a></li>
      </ul></div>
      <ul class="list">
        <li class="it"><a href="/a/1">첫 번째 공고 제목입니다</a></li>
        <li class="it"><a href="/a/2">두 번째 공고 제목입니다</a></li>
        <li class="it"><a href="/a/3">세 번째 공고 제목입니다</a></li>
      </ul>`);
    const { outline, result } = synth(html, titleItems);

    // 수정 전에는 commonSelector의 `li.it`가 그대로 채택되어 5행이 나왔다.
    expect(outline.document.querySelectorAll("li.it")).toHaveLength(5);
    expect(result?.spec.itemSelector).toBe("ul.list li.it");
    expect(applySpec(html, result!.spec, PAGE_URL).map((r) => r.title)).toEqual(SIMPLE_TITLES);
  });

  it("클래스·id가 없으면 루트까지의 경로로 다른 ul>li를 걸러낸다", () => {
    const html = page(`
      <div><ul>
        <li><a href="/a/1">첫 번째 공고 제목입니다</a></li>
        <li><a href="/a/2">두 번째 공고 제목입니다</a></li>
        <li><a href="/a/3">세 번째 공고 제목입니다</a></li>
      </ul></div>
      <div><ul>
        <li><a href="/o/1">목록이 아닌 반복 요소 하나</a></li>
        <li><a href="/o/2">목록이 아닌 반복 요소 둘</a></li>
      </ul></div>`);
    const { outline, result } = synth(html, titleItems);

    expect(outline.document.querySelectorAll("ul > li")).toHaveLength(5);
    expect(result?.spec.itemSelector).not.toBe("ul > li");
    expect(applySpec(html, result!.spec, PAGE_URL).map((r) => r.title)).toEqual(SIMPLE_TITLES);
  });

  it("행으로 감싼 그리드에서도 모든 루트를 포함하는 접두 후보로 사이드바 카드를 걸러낸다", () => {
    const card = (n: number) => `<div class="card"><h3><a href="/c/${n}">카드 제목 ${n}번</a></h3></div>`;
    const html = page(`<div class="grid">
      <div class="row">${card(1)}${card(2)}</div><div class="row">${card(3)}${card(4)}</div></div>
      <div class="side"><div class="card"><h3><a href="/o/1">목록 밖 카드 문구입니다</a></h3></div></div>`);
    const { result } = synth(html, (o) =>
      [1, 2, 3, 4].map((n) => ({ titleRef: refOf(o, `카드 제목 ${n}번`), titleText: `카드 제목 ${n}번`, fields: [] })),
    );

    expect(result?.spec.itemSelector).toBe("div.grid div.card");
    expect(applySpec(html, result!.spec, PAGE_URL)).toHaveLength(4);
  });

  it("공통 조상 안쪽의 초과분(같은 컨테이너의 다른 li.it)은 줄지 않는다 — 검증 단계의 몫", () => {
    const html = page(`
      <ul class="list">
        <li class="it"><a href="/a/1">첫 번째 공고 제목입니다</a></li>
        <li class="it"><a href="/a/2">두 번째 공고 제목입니다</a></li>
        <li class="it"><a href="/a/3">세 번째 공고 제목입니다</a></li>
        <li class="it"><a href="/p/2">다음 페이지로 이동하는 링크</a></li>
      </ul>`);
    const { result } = synth(html, titleItems);

    expect(result?.spec.itemSelector).toBe("li.it");
    expect(applySpec(html, result!.spec, PAGE_URL)).toHaveLength(4);
  });

  it("목록 밖 반복 요소를 제목으로 삼지는 않는다 (루트는 보고된 제목에서만 나온다)", () => {
    const html = page(`
      <ul class="menu-like"><li><a href="/m/1">반복 메뉴 하나입니다</a></li><li><a href="/m/2">반복 메뉴 둘입니다</a></li></ul>
      <div class="board">
        <div class="row"><a href="/a/1">첫 번째 공고 제목입니다</a></div>
        <div class="row"><a href="/a/2">두 번째 공고 제목입니다</a></div>
      </div>`);
    const { result } = synth(html, (o) =>
      SIMPLE_TITLES.slice(0, 2).map((t) => ({ titleRef: refOf(o, t), titleText: t, fields: [] })),
    );

    expect(result?.spec.itemSelector).toBe("div.row");
  });
});

describe("제목 셀렉터를 만들 수 없을 때", () => {
  it("제목이 항목 루트의 직계 텍스트면 titleSelector를 센티넬로 두고 applySpec이 제목과 필드를 뽑는다", () => {
    const html = page(`
      <ul class="list">
        <li>2026년 지원사업 공고 <span class="date">2026-01-05</span></li>
        <li>데이터 활용 기업 모집 <span class="date">2026-01-04</span></li>
      </ul>`);
    const titles = ["2026년 지원사업 공고", "데이터 활용 기업 모집"];
    const dates = ["2026-01-05", "2026-01-04"];
    const { outline, result } = synth(html, (o) =>
      titles.map((title, i) => ({
        // 텍스트 노드의 ref는 부모 요소(li)다. 그 li가 항목 루트 자신이다.
        titleRef: o.refs.findIndex((el) => el?.tagName === "LI" && fold(el.textContent).startsWith(title)),
        titleText: title,
        fields: [field("date_text", refOf(o, dates[i]), dates[i])],
      })),
    );

    expect(outline.refs.filter((el) => el?.tagName === "LI")).toHaveLength(2);
    expect(result?.spec.itemSelector).toBe("ul.list > li");
    expect(result?.spec.titleSelector).toBe(SELF_TITLE_SELECTOR);
    expect(result?.spec.fields?.date_text?.selector).toBe("span.date");
    // 앵커가 없어 링크만 못 만든다.
    expect(result?.dropped).toEqual([{ key: "link", reason: expect.stringContaining("a[href]") }]);

    const rows = applySpec(html, result!.spec, PAGE_URL);
    expect(rows.map((r) => ({ title: r.title, link: r.link, attrs: r.attrs }))).toEqual([
      { title: titles[0], link: null, attrs: { date_text: dates[0] } },
      { title: titles[1], link: null, attrs: { date_text: dates[1] } },
    ]);
  });

  it("일부 항목만 제목이 항목 루트 자신이면 센티넬을 쓰지 않고 생략한다", () => {
    const html = page(`
      <ul class="list">
        <li>텍스트로만 된 제목입니다 <span class="date">2026-01-05</span></li>
        <li><a href="/a/2">앵커로 된 제목입니다</a><span class="date">2026-01-04</span></li>
        <li><a href="/a/3">또 다른 앵커 제목입니다</a><span class="date">2026-01-03</span></li>
      </ul>`);
    const { result } = synth(html, (o) => [
      {
        titleRef: o.refs.findIndex((el) => el?.tagName === "LI" && fold(el.textContent).startsWith("텍스트로만")),
        titleText: "텍스트로만 된 제목입니다",
        fields: [field("date_text", refOf(o, "2026-01-05"), "2026-01-05")],
      },
      {
        titleRef: refOf(o, "앵커로 된 제목입니다"),
        titleText: "앵커로 된 제목입니다",
        fields: [field("date_text", refOf(o, "2026-01-04"), "2026-01-04")],
      },
      {
        titleRef: refOf(o, "또 다른 앵커 제목입니다"),
        titleText: "또 다른 앵커 제목입니다",
        fields: [field("date_text", refOf(o, "2026-01-03"), "2026-01-03")],
      },
    ]);

    expect(result?.spec.titleSelector).toBeUndefined();
    expect(result?.dropped).toContainEqual({ key: "title", reason: expect.stringContaining("일부 항목만") });
  });

  it("제목 상대 셀렉터가 항목마다 달라 일반화되지 않으면 생략하고, 기존 추측이 제목·필드를 뽑는다", () => {
    const html = page(`
      <ul class="list">
        <li><a href="/a/1">첫 번째 공고 제목입니다</a><span class="org">기관 하나</span></li>
        <li><a href="/a/2"><span class="t">두 번째 공고 제목입니다</span></a><span class="org">기관 둘</span></li>
      </ul>`);
    const { result } = synth(html, (o) =>
      SIMPLE_TITLES.slice(0, 2).map((title, i) => ({
        // 둘째 항목은 앵커가 아니라 그 안쪽 span을 가리켜 첫 항목과 경로의 끝이 달라진다.
        titleRef: o.refs.findIndex((el) => el?.tagName === (i === 0 ? "A" : "SPAN") && fold(el.textContent) === title),
        titleText: title,
        fields: [field("organization", refOf(o, SIMPLE_ORGS[i]), SIMPLE_ORGS[i])],
      })),
    );

    expect(result?.spec.titleSelector).toBeUndefined();
    expect(result?.spec.linkSelector).toBe("a:nth-child(1)");
    expect(result?.dropped).toEqual([{ key: "title", reason: expect.stringContaining("titleSelector를 생략") }]);
    const rows = applySpec(html, result!.spec, PAGE_URL);
    expect(rows.map(({ title, link, attrs }) => ({ title, link, attrs }))).toEqual([
      { title: SIMPLE_TITLES[0], link: "https://www.example.kr/a/1", attrs: { organization: "기관 하나" } },
      { title: SIMPLE_TITLES[1], link: "https://www.example.kr/a/2", attrs: { organization: "기관 둘" } },
    ]);
  });

  it("그래도 목록 자체를 못 찾는 경우(itemSelector 불가)는 여전히 null이다", () => {
    const html = page(`
      <div><p><a href="/a/1">첫 번째 공고 제목입니다</a></p></div>
      <section><article><a href="/a/2">두 번째 공고 제목입니다</a></article></section>`);
    const { result } = synth(html, (o) =>
      SIMPLE_TITLES.slice(0, 2).map((t) => ({ titleRef: refOf(o, t), titleText: t, fields: [] })),
    );
    expect(result).toBeNull();
  });
});
