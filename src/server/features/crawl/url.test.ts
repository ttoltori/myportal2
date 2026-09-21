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
