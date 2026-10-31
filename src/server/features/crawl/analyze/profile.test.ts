import { describe, expect, it } from "vitest";
import type { CrawlSpec } from "../extract";
import type { RenderTimings } from "../render";
import {
  buildFetchProfile,
  fetchProfileSchema,
  profileFromLegacySpec,
  settleBudget,
} from "./profile";

const PAGE_URL = "https://example.kr/board";

const timings = (over: Partial<RenderTimings> = {}): RenderTimings => ({
  readyMs: 2000,
  readyBy: "stabilized",
  grewByScroll: false,
  ...over,
});

// 링크를 가진 li n개. applySpec이 n행을 뽑는 최소 HTML.
const listHtml = (n: number): string =>
  `<html><body><ul>${Array.from(
    { length: n },
    (_, i) => `<li class="row"><a href="/p/${i}">2026년 지원사업 공고 ${i}</a></li>`,
  ).join("")}</ul></body></html>`;

const spec: CrawlSpec = { strategy: "html", itemSelector: "li.row", fields: {} };

const build = (over: Partial<Parameters<typeof buildFetchProfile>[0]> = {}) =>
  buildFetchProfile({
    staticHtml: listHtml(10),
    renderedHtml: listHtml(10),
    spec,
    timings: timings(),
    strategy: "html",
    pageUrl: PAGE_URL,
    ...over,
  });

describe("settleBudget", () => {
  it("측정값의 1.5배를 쓴다", () => {
    expect(settleBudget(timings({ readyMs: 2000 }))).toBe(3000);
  });

  it("하한 1500을 적용한다", () => {
    expect(settleBudget(timings({ readyMs: 200 }))).toBe(1500);
  });

  it("상한 20000을 적용한다", () => {
    expect(settleBudget(timings({ readyMs: 30000 }))).toBe(20000);
  });

  it("하한·상한 경계 직전과 직후를 구분한다", () => {
    // 1.5배가 정확히 1500이 되는 1000, 직전(999 -> 1499 -> 1500), 직후(1001 -> 1502)
    expect(settleBudget(timings({ readyMs: 999 }))).toBe(1500);
    expect(settleBudget(timings({ readyMs: 1000 }))).toBe(1500);
    expect(settleBudget(timings({ readyMs: 1001 }))).toBe(1502);
    // 1.5배가 정확히 20000이 되는 값 13334 근처
    expect(settleBudget(timings({ readyMs: 13332 }))).toBe(19998);
    expect(settleBudget(timings({ readyMs: 13334 }))).toBe(20000);
    expect(settleBudget(timings({ readyMs: 13400 }))).toBe(20000);
  });

  it("readyBy가 timeout이면 측정값을 믿지 않고 상한을 쓴다", () => {
    expect(settleBudget(timings({ readyMs: 500, readyBy: "timeout" }))).toBe(
      20000,
    );
  });
});

describe("buildFetchProfile", () => {
  it("전략이 rss면 mode=feed이고 셀렉터를 담지 않는다", () => {
    const p = build({ strategy: "rss" });
    expect(p.mode).toBe("feed");
    expect(p.waitForSelector).toBeUndefined();
  });

  it("정적 행 수가 렌더 행 수의 0.8 이상이면 mode=static", () => {
    const p = build({ staticHtml: listHtml(8), renderedHtml: listHtml(10) });
    expect(p.mode).toBe("static");
  });

  it("정적 행 수가 모자라면 mode=rendered", () => {
    const p = build({ staticHtml: listHtml(7), renderedHtml: listHtml(10) });
    expect(p.mode).toBe("rendered");
  });

  it("렌더 행이 0이면 mode=rendered로 두고 셀렉터를 담지 않는다", () => {
    const p = build({ staticHtml: listHtml(0), renderedHtml: listHtml(0) });
    expect(p.mode).toBe("rendered");
    expect(p.waitForSelector).toBeUndefined();
  });

  it("mode=rendered면 itemSelector를 waitForSelector에 담는다", () => {
    const p = build({ staticHtml: listHtml(0), renderedHtml: listHtml(10) });
    expect(p.mode).toBe("rendered");
    expect(p.waitForSelector).toBe("li.row");
    expect(p.settleMs).toBe(3000);
    expect(p.measuredReadyMs).toBe(2000);
    expect(p.measuredReadyBy).toBe("stabilized");
  });

  it("grewByScroll이면 scrollToBottom=true", () => {
    const p = build({
      staticHtml: listHtml(0),
      timings: timings({ grewByScroll: true }),
    });
    expect(p.scrollToBottom).toBe(true);
  });

  it("grewByScroll이 아니면 scrollToBottom 키가 없다", () => {
    const p = build({ staticHtml: listHtml(0) });
    expect("scrollToBottom" in p).toBe(false);
  });

  it("mode=static이면 waitForSelector와 settleMs를 담지 않는다", () => {
    const p = build();
    expect(p.mode).toBe("static");
    expect("waitForSelector" in p).toBe(false);
    expect("settleMs" in p).toBe(false);
  });

  it("measuredAt을 ISO 8601로 기록한다", () => {
    const p = build();
    expect(new Date(p.measuredAt).toISOString()).toBe(p.measuredAt);
  });
});

// JSON-LD ItemList를 담은 문서. 항목이 n개이고 itemListElement가 3개 미만이면 parseJsonLdList가 null이다.
const jsonLdHtml = (n: number): string => {
  const items = Array.from({ length: n }, (_, i) => ({
    "@type": "ListItem",
    position: i + 1,
    url: `https://example.kr/p/${i}`,
    name: `2026년 지원사업 공고 ${i}`,
  }));
  const data = { "@type": "ItemList", itemListElement: items };
  return `<html><body><script type="application/ld+json">${JSON.stringify(data)}</script></body></html>`;
};

const structuredSpec: CrawlSpec = { strategy: "structured" };

describe("buildFetchProfile - structured", () => {
  const buildStructured = (over: Partial<Parameters<typeof buildFetchProfile>[0]> = {}) =>
    build({
      spec: structuredSpec,
      strategy: "structured",
      staticHtml: jsonLdHtml(10),
      renderedHtml: jsonLdHtml(10),
      ...over,
    });

  // 이전에는 applySpec이 JSON-LD 스펙에서 양쪽 0건을 내 항상 rendered였다.
  it("정적 HTML에도 JSON-LD가 있으면 mode=static이다", () => {
    expect(buildStructured().mode).toBe("static");
  });

  it("정적 HTML에 JSON-LD가 없고 렌더 DOM에만 있으면 mode=rendered다", () => {
    const p = buildStructured({ staticHtml: "<html><body></body></html>" });
    expect(p.mode).toBe("rendered");
    // JSON-LD 전략에는 항목 셀렉터가 없으므로 기다릴 셀렉터를 담지 않는다.
    expect(p.waitForSelector).toBeUndefined();
  });

  it("정적 항목 수가 렌더 항목 수의 0.8 미만이면 mode=rendered다", () => {
    expect(buildStructured({ staticHtml: jsonLdHtml(7), renderedHtml: jsonLdHtml(10) }).mode).toBe(
      "rendered",
    );
  });

  it("렌더 DOM에서도 JSON-LD가 없으면 mode=rendered다", () => {
    const empty = "<html><body></body></html>";
    expect(buildStructured({ staticHtml: empty, renderedHtml: empty }).mode).toBe("rendered");
  });
});

describe("profileFromLegacySpec", () => {
  it("spec.render가 true면 mode=rendered", () => {
    expect(profileFromLegacySpec({ ...spec, render: true }).mode).toBe(
      "rendered",
    );
  });

  it("spec이 null이면 mode=static", () => {
    expect(profileFromLegacySpec(null).mode).toBe("static");
  });

  it("strategy가 rss인 spec이면 mode=feed", () => {
    const rss: CrawlSpec = { strategy: "rss", feedUrl: "https://x.kr/feed" };
    expect(profileFromLegacySpec(rss).mode).toBe("feed");
  });

  it("측정한 적이 없으므로 대기 설정은 비워 기본값을 쓰게 한다", () => {
    const p = profileFromLegacySpec({ ...spec, render: true });
    expect(p.waitForSelector).toBeUndefined();
    expect(p.settleMs).toBeUndefined();
    expect(fetchProfileSchema.safeParse(p).success).toBe(true);
  });
});

describe("fetchProfileSchema", () => {
  it("fetchProfileSchema가 알 수 없는 키를 걸러낸다", () => {
    const parsed = fetchProfileSchema.parse({
      mode: "static",
      measuredAt: "2026-10-31T00:00:00.000Z",
      leftover: "x",
    });
    expect(parsed).toEqual({
      mode: "static",
      measuredAt: "2026-10-31T00:00:00.000Z",
    });
  });

  it("settleMs가 0 이하이면 거부한다 — Playwright에서 0은 무제한 대기", () => {
    const base = { mode: "rendered", measuredAt: "2026-10-31T00:00:00.000Z" };
    expect(fetchProfileSchema.safeParse({ ...base, settleMs: 0 }).success).toBe(
      false,
    );
    expect(
      fetchProfileSchema.safeParse({ ...base, settleMs: -1 }).success,
    ).toBe(false);
    expect(
      fetchProfileSchema.safeParse({ ...base, settleMs: 1500 }).success,
    ).toBe(true);
  });

  it("measuredReadyMs가 음수이면 거부하고 0은 허용한다", () => {
    const base = { mode: "static", measuredAt: "2026-10-31T00:00:00.000Z" };
    expect(
      fetchProfileSchema.safeParse({ ...base, measuredReadyMs: -1 }).success,
    ).toBe(false);
    expect(
      fetchProfileSchema.safeParse({ ...base, measuredReadyMs: 0 }).success,
    ).toBe(true);
  });

  it("measuredAt이 ISO 8601이 아니면 거부한다", () => {
    expect(
      fetchProfileSchema.safeParse({ mode: "static", measuredAt: "어제" })
        .success,
    ).toBe(false);
  });

  it("레거시 폴백의 measuredAt(에포크)은 스키마를 통과한다", () => {
    expect(fetchProfileSchema.safeParse(profileFromLegacySpec(null)).success).toBe(
      true,
    );
  });

  it("빈 객체는 거부한다 — 호출자가 legacy 경로로 분기하는 기준", () => {
    expect(fetchProfileSchema.safeParse({}).success).toBe(false);
  });
});
