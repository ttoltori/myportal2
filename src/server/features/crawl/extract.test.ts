import { describe, expect, it } from "vitest";
import { fieldsFromRows } from "./analyze";
import {
  applySpec,
  discoverFeedUrl,
  generateSpec,
  looksLikeFeed,
  parseDate,
  parseFeed,
  parseJsonLdList,
  SELF_TITLE_SELECTOR,
  type CrawlSpec,
  type ExtractedRow,
} from "./extract";

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Example</title>
  <item>
    <title>공고 A</title>
    <link>/notice/1</link>
    <pubDate>Mon, 15 Sep 2025 09:00:00 +0900</pubDate>
    <description>첫 번째 공고입니다.</description>
  </item>
  <item>
    <title>공고 B</title>
    <link>https://x.go.kr/notice/2</link>
    <pubDate>Tue, 16 Sep 2025 09:00:00 +0900</pubDate>
  </item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Entry One</title>
    <link rel="alternate" href="https://x.com/e1"/>
    <published>2025-09-15T00:00:00Z</published>
    <summary>요약</summary>
  </entry>
  <entry>
    <title>Entry Two</title>
    <link href="https://x.com/e2"/>
    <updated>2025-09-16T00:00:00Z</updated>
  </entry>
</feed>`;

describe("looksLikeFeed", () => {
  it("detects via content type and body sniffing", () => {
    expect(looksLikeFeed("application/rss+xml", "")).toBe(true);
    expect(looksLikeFeed("text/html", '<?xml version="1.0"?><rss>')).toBe(true);
    expect(looksLikeFeed("text/html", "<html><body>")).toBe(false);
  });
});

describe("parseFeed", () => {
  it("parses RSS items with relative link resolution", () => {
    const rows = parseFeed(RSS, "https://x.go.kr/board");
    expect(rows).toHaveLength(2);
    expect(rows[0].title).toBe("공고 A");
    expect(rows[0].link).toBe("https://x.go.kr/notice/1");
    expect(rows[0].publishedAt).toContain("2025-09-15");
    expect(rows[0].attrs.description).toContain("첫 번째");
  });

  it("parses Atom entries", () => {
    const rows = parseFeed(ATOM, "https://x.com");
    expect(rows).toHaveLength(2);
    expect(rows[0].link).toBe("https://x.com/e1");
    expect(rows[1].publishedAt).toContain("2025-09-16");
  });
});

describe("discoverFeedUrl", () => {
  it("finds alternate feed link", () => {
    const html = `<html><head>
      <link rel="alternate" type="application/rss+xml" href="/feed.xml">
    </head><body></body></html>`;
    expect(discoverFeedUrl(html, "https://x.com/blog")).toBe(
      "https://x.com/feed.xml",
    );
  });
  it("returns null when absent", () => {
    expect(discoverFeedUrl("<html></html>", "https://x.com")).toBeNull();
  });
});

describe("parseJsonLdList", () => {
  it("extracts ItemList with >=3 entries", () => {
    const ld = {
      "@context": "https://schema.org",
      "@type": "ItemList",
      itemListElement: [1, 2, 3].map((i) => ({
        "@type": "ListItem",
        item: { name: `항목 ${i}`, url: `/n/${i}`, datePublished: "2025-09-15" },
      })),
    };
    const html = `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head></html>`;
    const rows = parseJsonLdList(html, "https://x.go.kr");
    expect(rows).toHaveLength(3);
    expect(rows?.[0].link).toBe("https://x.go.kr/n/1");
  });

  it("returns null without a list", () => {
    expect(parseJsonLdList("<html></html>", "https://x.com")).toBeNull();
  });
});

describe("parseDate", () => {
  it("parses ISO and Korean dotted dates", () => {
    expect(parseDate("2025-09-15T09:00:00+09:00")).toContain("2025-09-15");
    expect(parseDate("2025.09.15")).toContain("2025-09-1");
    expect(parseDate("Mon, 15 Sep 2025 09:00:00 GMT")).toContain("2025-09-15");
  });
  it("returns null for empty/garbage", () => {
    expect(parseDate("")).toBeNull();
    expect(parseDate("no date here")).toBeNull();
  });
});

describe("applySpec", () => {
  it("extracts rows via itemSelector and field selectors", () => {
    const html = `<html><body><ul class="board">
      <li><a href="/n/1">2025년도 사업 공고 안내</a><time datetime="2025-09-15">2025-09-15</time><span class="deadline">2025-09-30</span></li>
      <li><a href="/n/2">연구개발 과제 모집 공고</a><time datetime="2025-09-16">2025-09-16</time></li>
    </ul></body></html>`;
    const rows = applySpec(html, {
      strategy: "html",
      itemSelector: "ul.board li",
      fields: { deadline: { selector: ".deadline" } },
    }, "https://x.go.kr/board");
    expect(rows).toHaveLength(2);
    expect(rows[0].title).toBe("2025년도 사업 공고 안내");
    expect(rows[0].link).toBe("https://x.go.kr/n/1");
    expect(rows[0].publishedAt).toContain("2025-09-15");
    expect(rows[0].attrs.deadline).toBe("2025-09-30");
    expect(rows[1].attrs.deadline).toBeUndefined();
  });
});

describe("generateSpec", () => {
  // wevity.com 같은 게시판 페이지: 좌측 카테고리 메뉴가 항목 수는 많지만
  // 본문 목록(긴 제목)이 선택되어야 한다.
  const BOARD_HTML = `<html><body>
    <div id="gnb"><div class="menu-area"><ul class="m-menus">
      ${Array.from({ length: 12 }, (_, i) => `<li><a href="?c=find&cidx=${i}">카테고리${i}</a></li>`).join("")}
    </ul></div></div>
    <div class="aside"><ul class="aside-cat">
      ${Array.from({ length: 15 }, (_, i) => `<li><a href="?c=find&gub=${i}">분야${i}</a></li>`).join("")}
    </ul></div>
    <div class="content"><div class="ms-list"><ul class="list">
      ${[1, 2, 3, 4, 5]
        .map(
          (i) => `<li class="${i % 2 ? "bg" : "top"}">
            <div class="tit"><a href="?c=find&gbn=view&ix=${i}">제${i}회 전국 아이디어 공모전 모집 안내</a></div>
          </li>`,
        )
        .join("")}
    </ul></div></div>
  </body></html>`;

  it("메뉴가 아니라 본문 목록을 선택한다", () => {
    const gen = generateSpec(BOARD_HTML, "https://x.kr/?c=find");
    expect(gen).not.toBeNull();
    expect(gen!.spec.itemSelector).toBe("ul.list > li");
    expect(gen!.rows).toHaveLength(5);
    expect(gen!.rows[0].link).toBe("https://x.kr/?c=find&gbn=view&ix=1");
    expect(gen!.rows[0].title).toContain("아이디어 공모전");
  });

  it("클래스 변형(li.top/li.bg)도 같은 버킷으로 묶는다", () => {
    const gen = generateSpec(BOARD_HTML, "https://x.kr/");
    expect(gen!.rows.length).toBe(5); // top/bg 섞인 5개 전부
  });

  it("nav/aside/menu 클래스 컨테이너는 노이즈로 제거한다", () => {
    const gen = generateSpec(BOARD_HTML, "https://x.kr/");
    // 메뉴 링크(cidx/gub)가 결과에 섞이면 안 된다
    expect(gen!.rows.every((r) => r.link?.includes("gbn=view"))).toBe(true);
  });

  it("힌트 문자열이 포함된 영역을 우선 선택한다", () => {
    // 메뉴 버킷이 더 크지만 힌트가 본문 목록을 가리키면 본문이 선택되어야 한다
    const html = `<html><body>
      <ul class="items">
        ${[1, 2, 3, 4, 5].map((i) => `<li><a href="/m/${i}">사이드 메뉴 항목 번호${i}입니다</a></li>`).join("")}
      </ul>
      <ul class="news">
        ${[1, 2, 3].map((i) => `<li><a href="/n/${i}">공고 ${i}번 안내드립니다</a></li>`).join("")}
      </ul>
    </body></html>`;
    const gen = generateSpec(html, "https://x.kr/", "공고 2번");
    expect(gen).not.toBeNull();
    expect(gen!.hintMatched).toBe(true);
    expect(gen!.spec.itemSelector).toBe("ul.news > li");
    expect(gen!.spec.hint).toBe("공고 2번");
    expect(gen!.rows).toHaveLength(3);
  });

  it("힌트를 페이지에서 찾지 못하면 자동 추정으로 진행한다", () => {
    const html = `<html><body><ul class="news">
      ${[1, 2, 3].map((i) => `<li><a href="/n/${i}">공고 ${i}번 안내드립니다</a></li>`).join("")}
    </ul></body></html>`;
    const gen = generateSpec(html, "https://x.kr/", "존재하지 않는 문자열");
    expect(gen).not.toBeNull();
    expect(gen!.hintMatched).toBe(false);
    expect(gen!.spec.itemSelector).toBe("ul.news > li");
  });

  it("앵커 안 배지 텍스트는 제목에서 제외한다", () => {
    const html = `<html><body><ul class="list">
      ${[1, 2, 3]
        .map(
          (i) => `<li><div class="tit">
            <a href="/v/${i}">공모전 제목 ${i}번<span class="stat spec">SPECIAL</span><span class="stat idea">IDEA</span></a>
          </div></li>`,
        )
        .join("")}
    </ul></body></html>`;
    const gen = generateSpec(html, "https://x.kr/");
    expect(gen!.rows[0].title).toBe("공모전 제목 1번");
  });

  // thinkcontest.com 같은 JS 클릭 목록: tr에 앵커가 없고 data-* 키만 있다.
  const JS_LIST_HTML = `<html><body>
    <a href="https://x.kr/contest/view.do?contest_pk=999">이벤트 배너</a>
    <table><tbody id="dataList">
      ${[1, 2, 3]
        .map(
          (i) => `<tr class="contentitem" style="cursor:pointer" data-contest_pk="${1000 + i}">
            <td class="titTd"><div class="tit">제${i}회 전국 웹소설 공모전 모집</div></td>
            <td>주최사${i}</td><td>2025.10.${10 + i}</td>
          </tr>`,
        )
        .join("")}
    </tbody></table>
  </body></html>`;

  it("앵커 없는 JS 클릭 목록도 항목으로 추출한다", () => {
    const gen = generateSpec(JS_LIST_HTML, "https://x.kr/contest");
    expect(gen).not.toBeNull();
    expect(gen!.spec.itemSelector).toBe("#dataList > tr");
    expect(gen!.rows).toHaveLength(3);
    expect(gen!.rows[0].title).toContain("웹소설 공모전");
  });

  it("data-* 키를 페이지의 URL 템플릿에 대입해 링크를 복원한다", () => {
    const gen = generateSpec(JS_LIST_HTML, "https://x.kr/contest");
    expect(gen!.rows[0].link).toBe(
      "https://x.kr/contest/view.do?contest_pk=1001",
    );
    // applySpec(수집 경로)에서도 동일하게 복원되어야 한다
    const rows = applySpec(
      JS_LIST_HTML,
      { strategy: "html", itemSelector: "#dataList > tr", fields: {} },
      "https://x.kr/contest",
    );
    expect(rows[1].link).toBe("https://x.kr/contest/view.do?contest_pk=1002");
  });

  it("data-href 속성의 URL을 직접 링크로 사용한다", () => {
    const html = `<html><body><ul class="lst">
      ${[1, 2, 3]
        .map(
          (i) => `<li data-href="/post/${i}" style="cursor:pointer"><div class="tit">게시글 제목 ${i}번입니다</div></li>`,
        )
        .join("")}
    </ul></body></html>`;
    const gen = generateSpec(html, "https://x.kr/");
    expect(gen).not.toBeNull();
    expect(gen!.rows[0].link).toBe("https://x.kr/post/1");
  });

  // 위스켓처럼 검색 폼이 목록 전체를 감싸는 구조:
  // form/search 토큰 때문에 본문이 통째로 지워지면 안 된다.
  const FORM_LIST_HTML = `<html><body class="project-search">
    <form id="searchProjectListForm">
      <div class="search-box">
        <input type="text" placeholder="검색어">
        <a href="/submit">조건 검색</a>
      </div>
      <div class="search-result">
        ${[1, 2, 3, 4, 5]
          .map(
            (i) => `<div class="project-info-box"><div class="wrapper">
              <a class="project-link" href="/project/${i}"><p>프로젝트 개발 업무 공고 제목 ${i}번</p></a>
            </div></div>`,
          )
          .join("")}
      </div>
    </form>
  </body></html>`;

  it("form/search 노이즈 컨테이너 안의 본문 목록도 추출한다", () => {
    const gen = generateSpec(FORM_LIST_HTML, "https://x.kr/project/");
    expect(gen).not.toBeNull();
    expect(gen!.rows).toHaveLength(5);
    expect(gen!.rows[0].title).toContain("프로젝트 개발 업무 공고");
    expect(gen!.rows[0].link).toBe("https://x.kr/project/1");
  });

  it("검색 입력 폼과 class='search'의 본문 보존은 구분한다", () => {
    const gen = generateSpec(FORM_LIST_HTML, "https://x.kr/");
    // search-box 안의 '조건 검색' 링크는 결과에 섞이면 안 된다
    expect(gen!.rows.every((r) => r.link?.startsWith("https://x.kr/project/"))).toBe(true);
  });

  it("힌트가 앵커리스 목록을 가리키면 해당 목록을 선택한다", () => {
    const html = `<html><body>
      <ul class="snb">
        ${[1, 2, 3, 4, 5].map((i) => `<li><a href="/m/${i}">서브 메뉴 ${i}번입니다</a></li>`).join("")}
      </ul>
      <a href="https://x.kr/contest/view.do?contest_pk=999">배너</a>
      <table><tbody id="dataList">
        ${[1, 2, 3]
          .map(
            (i) => `<tr style="cursor:pointer" data-contest_pk="${2000 + i}">
              <td><div class="tit">제${i}회 웹소설 공모전 모집 안내</div></td>
            </tr>`,
          )
          .join("")}
      </tbody></table>
    </body></html>`;
    const gen = generateSpec(html, "https://x.kr/", "웹소설 공모전");
    expect(gen).not.toBeNull();
    expect(gen!.hintMatched).toBe(true);
    expect(gen!.spec.itemSelector).toBe("#dataList > tr");
  });

  // sbiz24.kr 같은 SPA 사이트는 href="#/extldPbanc/PBLN_123" 형태로
  // hash 라우팅을 사용한다. 이전에는 #로 시작하는 href를 무조건 거부해서
  // SPA 사이트의 목록을 전혀 추출하지 못했다.
  it("SPA hash 라우팅 링크(#/path)를 유효한 링크로 추출한다", () => {
    const html = `<html><body><table class="q-table"><tbody>
      ${[1, 2, 3, 4, 5]
        .map(
          (i) =>
            `<tr class="row"><td><a href="#/extldPbanc/PBLN_00${i}">지원사업 공고 제목 ${i}번입니다</a></td></tr>`,
        )
        .join("")}
    </tbody></table></body></html>`;
    const gen = generateSpec(html, "https://www.sbiz24.kr/");
    expect(gen).not.toBeNull();
    expect(gen!.rows).toHaveLength(5);
    expect(gen!.rows[0].link).toBe(
      "https://www.sbiz24.kr/#/extldPbanc/PBLN_001",
    );
    expect(gen!.rows[0].title).toContain("지원사업 공고 제목 1번");
  });
});

describe("fields 메타가 있는 스펙", () => {
  const pageUrl = "https://x.kr/list";
  const itemHtml = (extra: string) => `<html><body><ul>
    <li class="row"><a href="/v/1">공모전 제목 하나입니다</a>${extra}</li>
  </ul></body></html>`;

  it("applySpec이 추가 필드를 attrs로 추출한다", () => {
    const html = itemHtml(
      '<span class="org">서울시</span><span class="due">2026-11-30</span>',
    );
    const spec: CrawlSpec = {
      strategy: "html",
      itemSelector: "li.row",
      fields: { org: { selector: ".org" }, deadline: { selector: ".due" } },
    };
    const rows = applySpec(html, spec, pageUrl);
    expect(rows[0].attrs.org).toBe("서울시");
    expect(rows[0].attrs.deadline).toBe("2026-11-30");
  });

  it("type이 url인 필드의 상대 경로를 절대 URL로 바꾼다", () => {
    const html = itemHtml('<a class="file" href="/down/3">첨부</a>');
    const spec: CrawlSpec = {
      strategy: "html",
      itemSelector: "li.row",
      fields: { file: { selector: ".file", attr: "href", type: "url" } },
    };
    expect(applySpec(html, spec, pageUrl)[0].attrs.file).toBe(
      "https://x.kr/down/3",
    );
  });

  it("type이 url이 아닌 필드는 값을 그대로 둔다", () => {
    const html = itemHtml('<a class="file" href="/down/3">첨부</a>');
    const spec: CrawlSpec = {
      strategy: "html",
      itemSelector: "li.row",
      fields: { file: { selector: ".file", attr: "href" } },
    };
    expect(applySpec(html, spec, pageUrl)[0].attrs.file).toBe("/down/3");
  });

  it("절대화할 수 없는 값은 필드를 비운다", () => {
    const html = itemHtml('<a class="file" href="javascript:void(0)">첨부</a>');
    const spec: CrawlSpec = {
      strategy: "html",
      itemSelector: "li.row",
      fields: { file: { selector: ".file", attr: "href", type: "url" } },
    };
    expect(applySpec(html, spec, pageUrl)[0].attrs.file).toBeUndefined();
  });
});

describe("명시적 제목·링크·게시일 셀렉터", () => {
  const pageUrl = "https://x.kr/list";
  // 긴 앵커(요약 링크)와 짧은 제목 앵커가 한 항목에 공존한다 — 기존 추측은 긴 쪽을 고른다.
  const row = (i: number) => `<li class="row">
      <a class="more" href="/more/${i}">자세히 보기 및 신청 안내 페이지로 이동합니다 ${i}</a>
      <a class="subject" href="/v/${i}">공모전 ${i}</a>
      <span class="date">2026-01-0${i}</span>
      <span class="due">마감 2026-12-31</span>
    </li>`;
  const html = `<html><body><ul>${[1, 2, 3].map(row).join("")}</ul></body></html>`;
  const base: CrawlSpec = { strategy: "html", itemSelector: "li.row" };

  it("titleSelector가 있으면 그 요소의 텍스트를 제목으로 쓴다", () => {
    const rows = applySpec(html, { ...base, titleSelector: ".subject" }, pageUrl);
    expect(rows.map((r) => r.title)).toEqual(["공모전 1", "공모전 2", "공모전 3"]);
  });

  it("linkSelector가 있으면 그 요소의 href를 절대 URL로 링크에 쓴다", () => {
    const rows = applySpec(html, { ...base, linkSelector: ".subject" }, pageUrl);
    expect(rows[0].link).toBe("https://x.kr/v/1");
    // 제목은 지정하지 않았으므로 기존 추측(가장 긴 앵커)이 그대로다.
    expect(rows[0].title).toContain("자세히 보기");
  });

  it("publishedSelector가 있으면 그 요소에서만 날짜를 찾는다", () => {
    const rows = applySpec(html, { ...base, publishedSelector: ".date" }, pageUrl);
    expect(rows[0].publishedAt).toContain("2026-01-01");
    // .due를 가리키면 항목 전체 텍스트의 다른 날짜(.date)는 영향을 주지 않는다.
    // '마감 2026-12-31'은 정규식 경로로 파싱돼 로컬 자정이므로 같은 방식으로 기대값을 만든다.
    const due = applySpec(html, { ...base, publishedSelector: ".due" }, pageUrl);
    expect(due[0].publishedAt).toBe(new Date(2026, 11, 31).toISOString());
  });

  it("publishedSelector 요소의 datetime 속성을 텍스트보다 우선한다", () => {
    const h = `<html><body><ul><li class="row"><a href="/v/1">공모전 제목 하나입니다</a>
      <time datetime="2026-05-05">5월 5일</time><span class="due">2026-12-31</span></li></ul></body></html>`;
    const rows = applySpec(h, { ...base, publishedSelector: "time" }, pageUrl);
    expect(rows[0].publishedAt).toContain("2026-05-05");
  });

  it("titleSelector가 매칭되지 않는 항목은 기존 앵커 추측으로 폴백한다", () => {
    const rows = applySpec(html, { ...base, titleSelector: ".nope" }, pageUrl);
    expect(rows[0].title).toContain("자세히 보기");
    expect(rows[0].link).toBe("https://x.kr/more/1");
  });

  it("linkSelector·publishedSelector가 매칭되지 않으면 기존 경로로 폴백한다", () => {
    const rows = applySpec(
      html,
      { ...base, linkSelector: ".nope", publishedSelector: ".nope" },
      pageUrl,
    );
    expect(rows[0].link).toBe("https://x.kr/more/1");
    expect(rows[0].publishedAt).toBe(applySpec(html, base, pageUrl)[0].publishedAt);
    expect(rows[0].publishedAt).not.toBeNull();
  });

  it("문법이 틀린 셀렉터는 예외 없이 폴백한다", () => {
    const rows = applySpec(
      html,
      {
        ...base,
        titleSelector: "[[[",
        linkSelector: "[[[",
        publishedSelector: "[[[",
      },
      pageUrl,
    );
    expect(rows).toHaveLength(3);
    expect(rows[0].title).toContain("자세히 보기");
  });

  it("세 셀렉터가 모두 없으면 기존 동작과 동일하다", () => {
    const withOptionalFields = applySpec(
      html,
      { ...base, hintSetAt: "2026-01-01T00:00:00.000Z" },
      pageUrl,
    );
    expect(withOptionalFields).toEqual(applySpec(html, base, pageUrl));
    expect(withOptionalFields[0].title).toContain("자세히 보기");
    expect(withOptionalFields[0].link).toBe("https://x.kr/more/1");
  });

  it("titleSelector로도 제목을 못 찾고 앵커·제목 후보도 없으면 그 항목을 건너뛴다", () => {
    const h = `<html><body><ul>
      <li class="row"><span>짧음</span></li>
      <li class="row"><a href="/v/2">공모전 제목 둘입니다</a></li>
    </ul></body></html>`;
    const rows = applySpec(h, { ...base, titleSelector: ".nope" }, pageUrl);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("공모전 제목 둘입니다");
  });

  it("앵커가 없는 항목도 titleSelector로 제목을 얻는다", () => {
    const h = `<html><body><ul>
      <li class="row" data-href="/v/1"><span class="t">짧은</span></li>
    </ul></body></html>`;
    const rows = applySpec(h, { ...base, titleSelector: ".t" }, pageUrl);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("짧은");
    expect(rows[0].link).toBe("https://x.kr/v/1");
  });
});

describe("fieldsFromRows", () => {
  const row = (attrs: Record<string, unknown>): ExtractedRow => ({
    title: "제목",
    link: "https://x.kr/1",
    publishedAt: null,
    attrs,
  });

  it("spec의 label·type·role을 우선 사용한다", () => {
    const spec: CrawlSpec = {
      strategy: "html",
      itemSelector: "li",
      fields: {
        due: {
          selector: ".due",
          label: "접수기간",
          type: "date_range",
          role: "deadline",
        },
      },
    };
    const f = fieldsFromRows([row({ due: "2026-11-30" })], spec).find(
      (x) => x.key === "due",
    );
    expect(f?.label).toBe("접수기간");
    expect(f?.type).toBe("date_range");
    expect(f?.role).toBe("deadline");
  });

  it("spec이 없으면 기존 추정으로 폴백한다", () => {
    const fields = fieldsFromRows([row({ deadline: "2026-11-30", views: 12 })]);
    const deadline = fields.find((x) => x.key === "deadline");
    const views = fields.find((x) => x.key === "views");
    expect(deadline?.label).toBe("deadline");
    expect(deadline?.role).toBe("deadline");
    expect(views?.type).toBe("number");
    expect(views?.role).toBe("none");
  });

  it("spec에 없는 attrs 키도 기존 추정으로 필드를 만든다", () => {
    const spec: CrawlSpec = {
      strategy: "html",
      itemSelector: "li",
      fields: { org: { selector: ".org", label: "주최기관" } },
    };
    const fields = fieldsFromRows([row({ org: "서울시", extra: "x" })], spec);
    const extra = fields.find((x) => x.key === "extra");
    expect(extra?.label).toBe("extra");
    expect(extra?.role).toBe("none");
  });

  it("고정 3개 필드(title/link/published)가 항상 앞에 온다", () => {
    const fields = fieldsFromRows([row({ org: "서울시" })]);
    expect(fields.slice(0, 3).map((f) => f.key)).toEqual([
      "title",
      "link",
      "published",
    ]);
    expect(fields.slice(0, 3).map((f) => f.sortOrder)).toEqual([0, 1, 2]);
  });
});

describe("SELF_TITLE_SELECTOR (항목 자신의 직계 텍스트를 제목으로)", () => {
  const pageUrl = "https://x.kr/list";
  const html = `<html><body><ul class="list">
    <li>2026년 지원사업 공고 <span class="date">2026-01-05</span></li>
    <li>데이터 활용 기업 모집 <span class="date">2026-01-04</span></li>
    <li>  수출 바우처
        추가 모집  <span class="date">2026-01-03</span> 안내</li>
  </ul></body></html>`;
  const base: CrawlSpec = { strategy: "html", itemSelector: "ul.list > li" };

  it("직계 텍스트 노드만 제목이 되고 자식 요소(날짜)의 텍스트는 섞이지 않는다", () => {
    const rows = applySpec(
      html,
      {
        ...base,
        titleSelector: SELF_TITLE_SELECTOR,
        publishedSelector: "span.date",
        fields: { date_text: { selector: "span.date" } },
      },
      pageUrl,
    );

    // 공백은 접고, 자식 요소 앞뒤의 직계 텍스트는 이어 붙인다.
    expect(rows.map((r) => r.title)).toEqual([
      "2026년 지원사업 공고",
      "데이터 활용 기업 모집",
      "수출 바우처 추가 모집 안내",
    ]);
    expect(rows.map((r) => r.attrs.date_text)).toEqual(["2026-01-05", "2026-01-04", "2026-01-03"]);
    expect(rows[0].publishedAt).toContain("2026-01-05");
  });

  it("직계 텍스트가 300자를 넘으면 자른다", () => {
    const long = "가".repeat(400);
    const rows = applySpec(
      `<html><body><ul class="list"><li>${long}<b>x</b></li></ul></body></html>`,
      { ...base, titleSelector: SELF_TITLE_SELECTOR },
      pageUrl,
    );
    expect(rows[0].title).toHaveLength(300);
  });

  it("직계 텍스트가 비면 기존 폴백(가장 긴 앵커)으로 내려가고, 그것도 없으면 항목을 건너뛴다", () => {
    const mixed = `<html><body><ul class="list">
      <li><a href="/v/1">앵커로만 이루어진 제목</a><span class="date">2026-01-05</span></li>
      <li><span class="date">2026-01-04</span></li>
      <li>텍스트 제목 항목 <span class="date">2026-01-03</span></li>
    </ul></body></html>`;
    const rows = applySpec(mixed, { ...base, titleSelector: SELF_TITLE_SELECTOR }, pageUrl);

    expect(rows.map((r) => r.title)).toEqual(["앵커로만 이루어진 제목", "텍스트 제목 항목"]);
    expect(rows[0].link).toBe("https://x.kr/v/1");
  });

  it("센티넬이 없는 스펙은 직계 텍스트를 읽지 않는다 (기존 소스의 수집 결과가 바뀌지 않음)", () => {
    // 같은 HTML이라도 센티넬이 없으면 제목 후보가 없는 항목은 건너뛰어진다.
    expect(applySpec(html, base, pageUrl)).toEqual([]);
    expect(applySpec(html, { ...base, titleSelector: "span.date" }, pageUrl).map((r) => r.title)).toEqual([
      "2026-01-05",
      "2026-01-04",
      "2026-01-03",
    ]);
  });
});

describe("게시일 셀렉터가 가리킨 요소가 비었을 때", () => {
  const pageUrl = "https://x.kr/list";
  const base: CrawlSpec = { strategy: "html", itemSelector: "li.row", publishedSelector: ".date" };
  // 게시일 칸은 비었고 항목 텍스트에는 마감일만 있다 — 폴백하면 마감일이 게시일이 된다.
  const html = `<html><body><ul>
    <li class="row"><a href="/v/1">공모전 제목 하나입니다</a><span class="date"></span><span class="due">마감 2026-12-31</span></li>
    <li class="row"><a href="/v/2">공모전 제목 둘입니다</a><span class="date">   </span><span class="due">마감 2026-12-31</span></li>
  </ul></body></html>`;

  it("요소가 있지만 텍스트가 비면 항목 텍스트로 폴백하지 않고 null이다", () => {
    const rows = applySpec(html, base, pageUrl);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.publishedAt)).toEqual([null, null]);
  });

  it("같은 항목이라도 셀렉터를 지정하지 않으면 기존 추측이 마감일을 읽는다 (대조)", () => {
    const rows = applySpec(html, { strategy: "html", itemSelector: "li.row" }, pageUrl);
    expect(rows[0].publishedAt).not.toBeNull();
  });
});
