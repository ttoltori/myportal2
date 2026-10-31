import { z } from "zod";
import { applySpec, type CrawlSpec } from "../extract";
import type { RenderTimings } from "../render";

// 수집 프로파일: "어떻게 가져오는가". 스펙("가져온 것에서 무엇을 뽑는가")과
// 수명이 달라 sources.fetch_profile에 따로 저장한다. self-repair가 스펙을 바꿔도
// 측정한 대기 시간은 그대로 남아야 하기 때문이다.
export const fetchProfileSchema = z.object({
  mode: z.enum(["feed", "static", "rendered"]),
  // 로딩 완료 판정 셀렉터. 보통 itemSelector.
  waitForSelector: z.string().optional(),
  // 시간 기반 대기 상한(ms). 측정값 × 여유계수에 하한·상한을 적용한 값.
  settleMs: z.number().optional(),
  scrollToBottom: z.boolean().optional(),
  // 측정 근거 — 운영 추적과 재측정 판단에 쓴다.
  measuredReadyMs: z.number().optional(),
  measuredReadyBy: z
    .enum(["selector", "networkidle", "stabilized", "timeout"])
    .optional(),
  measuredAt: z.string(),
});

export type FetchProfile = z.infer<typeof fetchProfileSchema>;

// 수집 시점의 네트워크·서버 지연은 분석 시점보다 느릴 수 있어 여유를 둔다.
// waitForSelector가 먼저 잡히면 이 값은 쓰이지 않으므로 넉넉해도 비용이 없다.
const SETTLE_MARGIN = 1.5;
const SETTLE_MIN_MS = 1_500;
const SETTLE_MAX_MS = 20_000;
// 정적 HTML에서 렌더 결과의 이 비율 이상을 뽑으면 렌더링 없이도 충분하다고 본다.
const STATIC_YIELD_RATIO = 0.8;
// 측정한 적 없는 프로파일의 시각. 재측정 판단에서 가장 오래된 값으로 취급된다.
const NEVER_MEASURED_AT = new Date(0).toISOString();

export function settleBudget(timings: RenderTimings): number {
  // timeout은 "그 시간까지 기다려도 끝을 못 봤다"는 뜻이라 readyMs가 실제 완료 시간이
  // 아니다. 짧은 값을 믿고 줄이면 수집이 로딩 도중에 끊기므로 상한을 쓴다.
  if (timings.readyBy === "timeout") return SETTLE_MAX_MS;
  const budget = Math.round(timings.readyMs * SETTLE_MARGIN);
  return Math.min(SETTLE_MAX_MS, Math.max(SETTLE_MIN_MS, budget));
}

export function buildFetchProfile(args: {
  staticHtml: string;
  renderedHtml: string;
  spec: CrawlSpec;
  timings: RenderTimings;
  strategy: "rss" | "structured" | "html";
  pageUrl: string;
}): FetchProfile {
  const measuredAt = new Date().toISOString();
  if (args.strategy === "rss") return { mode: "feed", measuredAt };

  const measured = {
    measuredReadyMs: args.timings.readyMs,
    measuredReadyBy: args.timings.readyBy,
    measuredAt,
  };
  // 추측하지 않고 같은 스펙을 정적 HTML과 렌더 DOM 양쪽에 적용해 비교한다.
  const renderedRows = applySpec(args.renderedHtml, args.spec, args.pageUrl).length;
  const staticRows = applySpec(args.staticHtml, args.spec, args.pageUrl).length;

  if (renderedRows > 0 && staticRows >= renderedRows * STATIC_YIELD_RATIO) {
    return { mode: "static", ...measured };
  }
  return {
    mode: "rendered",
    // 렌더 결과에서도 못 뽑은 셀렉터는 기다려봐야 나타나지 않는다. 담으면 수집마다
    // 대기 상한만큼 허비하므로 담지 않고 시간 기반 판정에 맡긴다.
    ...(renderedRows > 0 && args.spec.itemSelector
      ? { waitForSelector: args.spec.itemSelector }
      : {}),
    settleMs: settleBudget(args.timings),
    ...(args.timings.grewByScroll ? { scrollToBottom: true } : {}),
    ...measured,
  };
}

// fetch_profile이 비어 있는 기존 소스용. 그때는 렌더링 필요 여부가 spec.render
// 하나에 담겨 있다. 측정값이 없으므로 대기 설정은 비워 renderPage 기본값을 쓰게 하고,
// 새 분석이 돌 때까지 기존 동작을 그대로 유지한다.
export function profileFromLegacySpec(spec: CrawlSpec | null): FetchProfile {
  if (spec?.strategy === "rss") {
    return { mode: "feed", measuredAt: NEVER_MEASURED_AT };
  }
  return {
    mode: spec?.render ? "rendered" : "static",
    measuredAt: NEVER_MEASURED_AT,
  };
}
