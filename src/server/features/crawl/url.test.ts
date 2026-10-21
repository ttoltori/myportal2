import { describe, expect, it } from "vitest";
import {
  absolutize,
  assertPublicUrl,
  dedupeHash,
  normalizeUrl,
  titleKey,
} from "./url";
import { AppError } from "../../errors/error-codes";

describe("normalizeUrl", () => {
  it("strips tracking params and hash", () => {
    const out = normalizeUrl(
      "https://Example.COM/path/?utm_source=x&a=1#frag",
    );
    expect(out).toBe("https://example.com/path?a=1");
  });

  it("sorts query params for stable dedupe", () => {
    const out = normalizeUrl("https://x.com/p?b=2&a=1");
    expect(out).toBe("https://x.com/p?a=1&b=2");
  });

  it("removes default ports", () => {
    expect(normalizeUrl("https://x.com:443/p")).toBe("https://x.com/p");
    expect(normalizeUrl("http://x.com:80/p")).toBe("http://x.com/p");
  });

  it("rejects non-http protocols and garbage", () => {
    expect(() => normalizeUrl("ftp://x.com/f")).toThrow(AppError);
    expect(() => normalizeUrl("not a url")).toThrow(AppError);
  });

  it("preserves SPA hash routes (#/path) but strips regular anchors", () => {
    // SPA hash 라우팅 사이트(예: sbiz24.kr)는 hash로 페이지를 식별한다.
    // #/path 또는 #!/path 형태는 보존하고, 일반 #anchor는 제거한다.
    expect(normalizeUrl("https://www.sbiz24.kr/#/combinePbancList?combine=combine")).toBe(
      "https://www.sbiz24.kr/#/combinePbancList?combine=combine",
    );
    expect(normalizeUrl("https://www.sbiz24.kr/#/pbanc")).toBe(
      "https://www.sbiz24.kr/#/pbanc",
    );
    expect(normalizeUrl("https://x.com/#!/page")).toBe(
      "https://x.com/#!/page",
    );
    // 일반 anchor는 제거
    expect(normalizeUrl("https://x.com/page#section")).toBe("https://x.com/page");
    expect(normalizeUrl("https://x.com/page#")).toBe("https://x.com/page");
  });
});

describe("assertPublicUrl (SSRF)", () => {
  it("allows public https hosts", () => {
    expect(assertPublicUrl("https://example.com/a").hostname).toBe(
      "example.com",
    );
  });

  it.each([
    "http://localhost/x",
    "http://127.0.0.1/x",
    "http://10.0.0.5/x",
    "http://192.168.1.1/x",
    "http://172.16.0.1/x",
    "http://169.254.169.254/latest",
    "http://[::1]/x",
    "http://foo.internal/x",
    "http://foo.local/x",
    "https://user:pass@example.com/x",
  ])("rejects %s", (u) => {
    expect(() => assertPublicUrl(u)).toThrow(AppError);
  });
});

describe("absolutize", () => {
  it("resolves relative hrefs against base", () => {
    expect(absolutize("/a/b", "https://x.com/p")).toBe("https://x.com/a/b");
    expect(absolutize("c", "https://x.com/p/")).toBe("https://x.com/p/c");
    expect(absolutize("//cdn.com/x", "https://x.com")).toBe(
      "https://cdn.com/x",
    );
  });

  it("returns null for unsafe or empty hrefs", () => {
    expect(absolutize("javascript:alert(1)", "https://x.com")).toBeNull();
    expect(absolutize("#frag", "https://x.com")).toBeNull();
    expect(absolutize("", "https://x.com")).toBeNull();
    expect(absolutize("mailto:a@b.com", "https://x.com")).toBeNull();
  });

  it("accepts SPA hash routes (#/path) as valid links", () => {
    // sbiz24.kr 같은 SPA 사이트는 href="#/extldPbanc/PBLN_123" 형태로
    // hash 라우팅을 사용한다. 순수 #anchor가 아닌 #/path는 유효한 페이지 이동.
    expect(absolutize("#/extldPbanc/PBLN_123", "https://www.sbiz24.kr/")).toBe(
      "https://www.sbiz24.kr/#/extldPbanc/PBLN_123",
    );
    expect(absolutize("#/pbanc/456", "https://www.sbiz24.kr/#/list")).toBe(
      "https://www.sbiz24.kr/#/pbanc/456",
    );
  });

  it("rejects bare hash anchors but accepts SPA routes", () => {
    expect(absolutize("#", "https://x.com")).toBeNull();
    expect(absolutize("#top", "https://x.com")).toBeNull();
    expect(absolutize("#section-1", "https://x.com")).toBeNull();
    // #/ 또는 #!/ 로 시작하면 SPA 라우트
    expect(absolutize("#/path", "https://x.com")).toBe("https://x.com/#/path");
    expect(absolutize("#!/path", "https://x.com")).toBe(
      "https://x.com/#!/path",
    );
  });
});

describe("dedupeHash / titleKey", () => {
  it("is stable and ignores title case/whitespace", () => {
    const a = dedupeHash("https://x.com", "Hello  World");
    const b = dedupeHash("https://x.com", "hello world");
    expect(a).toBe(b);
    expect(a).toHaveLength(32);
  });

  it("titleKey drops short words and punctuation", () => {
    expect(titleKey("AI, 로봇! a b")).toBe("ai 로봇");
  });
});
