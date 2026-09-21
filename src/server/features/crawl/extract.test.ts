import { describe, expect, it } from "vitest";
import {
  applySpec,
  discoverFeedUrl,
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
