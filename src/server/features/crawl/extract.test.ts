import { describe, expect, it } from "vitest";
import {
  applySpec,
  discoverFeedUrl,
  generateSpec,
  looksLikeFeed,
  parseDate,
  parseFeed,
  parseJsonLdList,
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
});
