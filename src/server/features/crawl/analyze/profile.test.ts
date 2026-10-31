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

  it("measuredAt을 ISO 8601로 기록한다", () => {
    const p = build();
    expect(new Date(p.measuredAt).toISOString()).toBe(p.measuredAt);
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

  it("빈 객체는 거부한다 — 호출자가 legacy 경로로 분기하는 기준", () => {
    expect(fetchProfileSchema.safeParse({}).success).toBe(false);
  });
});
