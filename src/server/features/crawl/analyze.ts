import type {
  AnalyzeResult,
  AnalyzeStep,
  PageKind,
  ParentCandidate,
  SourceField,
} from "@myportal/api-contracts";
import { getDb } from "../../config/db";
import { AppError, errorCodes, type ErrorCode } from "../../errors/error-codes";
import { hintMatchesOutline } from "./analyze/llm-read";
import { buildPageOutline } from "./analyze/page-outline";
import { buildFetchProfile, type FetchProfile } from "./analyze/profile";
import { runAnalysis, type AnalysisOutcome } from "./analyze/run-analysis";
import { fetchPage, type FetchResult } from "./fetcher";
import type { LlmPurpose } from "./llm/usage";
import { renderPage, type RenderTimings } from "./render";
import { robotsAllowed } from "./robots";
import {
  discoverFeedUrl,
  looksLikeFeed,
  parseFeed,
  type CrawlSpec,
  type ExtractedRow,
} from "./extract";
import { parseHTML } from "linkedom";
import { absolutize, assertPublicUrl, normalizeUrl } from "./url";

function step(
  label: string,
  status: AnalyzeStep["status"],
  detail: string | null = null,
): AnalyzeStep {
  return { label, status, detail };
}

// 사용자가 힌트 문자열을 직접 고를 수 있도록 HTML에서
// 블록 단위 텍스트만 추린다(태그·스크립트 제거, 빈 줄 정리).
const PAGE_TEXT_LINES = 400;
const PAGE_TEXT_LIMIT = 20_000;
function toPageText(html: string): string {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(
      /<\/(p|div|li|tr|td|th|h[1-6]|section|article|ul|ol|dl|dd|dt|table|a|button|option)>/gi,
      "\n",
    )
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(text)
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 1)
    .slice(0, PAGE_TEXT_LINES)
    .join("\n")
    .slice(0, PAGE_TEXT_LIMIT);
}

// 추출 샘플에서 필드 목록을 만든다. title/link/published는 고정 역할이고
// 나머지 키는 attrs에 들어간다.
// spec.fields에 표시 메타(label/type/role)가 있으면 그것을 우선하고,
// 없으면 샘플 값 기반 추정으로 폴백한다.
export function fieldsFromRows(
  rows: ExtractedRow[],
  spec?: CrawlSpec | null,
): SourceField[] {
  const fields: SourceField[] = [
    {
      key: "title",
      label: "제목",
      type: "text",
      role: "title",
      visible: true,
      sortOrder: 0,
    },
    {
      key: "link",
      label: "링크",
      type: "url",
      role: "link",
      visible: false,
      sortOrder: 1,
    },
    {
      key: "published",
      label: "게시일",
      type: "datetime",
      role: "published",
      visible: true,
      sortOrder: 2,
    },
  ];
  const extraKeys = new Set<string>();
  for (const r of rows.slice(0, 20)) {
    for (const k of Object.keys(r.attrs)) extraKeys.add(k);
  }
  let order = 3;
  for (const key of extraKeys) {
    const sample = rows.find((r) => r.attrs[key] !== undefined)?.attrs[key];
    const meta = spec?.fields?.[key];
    fields.push({
      key,
      label: meta?.label ?? key,
      type: meta?.type ?? guessFieldType(sample),
      role: meta?.role ?? (key === "deadline" ? "deadline" : "none"),
      visible: true,
      sortOrder: order++,
    });
  }
  return fields;
}

function guessFieldType(v: unknown): SourceField["type"] {
  if (typeof v === "number") return "number";
  if (typeof v === "string") {
    if (/^https?:\/\//.test(v)) return "url";
    if (Date.parse(v)) return "datetime";
  }
  return "text";
}

export interface AnalyzeOutcome {
  spec: CrawlSpec | null;
  rows: ExtractedRow[];
  strategy: "rss" | "structured" | "html";
  feedUrl: string | null;
}

const FEED_STEP = "RSS/Atom 피드 확인";

// 피드는 이미 구조화된 데이터라 렌더링도 LLM도 더할 것이 없다. 그래서 이 분기만은
// 렌더링 앞에서 끝낸다 (설계서 §3). 피드를 못 찾으면 null — 호출자가 렌더링으로 넘어간다.
async function detectFeed(
  page: FetchResult,
  steps: AnalyzeStep[],
): Promise<AnalyzeOutcome | null> {
  if (looksLikeFeed(page.contentType, page.body)) {
    const rows = parseFeed(page.body, page.finalUrl);
    if (rows.length > 0) {
      steps.push(step(FEED_STEP, "ok", `${rows.length}개 항목`));
      return {
        spec: { strategy: "rss" },
        rows,
        strategy: "rss",
        feedUrl: page.finalUrl,
      };
    }
  }

  const feedUrl = discoverFeedUrl(page.body, page.finalUrl);
  if (!feedUrl || feedUrl === page.finalUrl) {
    steps.push(step(FEED_STEP, "warn", "피드 없음"));
    return null;
  }
  try {
    const feed = await fetchPage(feedUrl);
    const rows = looksLikeFeed(feed.contentType, feed.body)
      ? parseFeed(feed.body, feed.finalUrl)
      : [];
    if (rows.length === 0) {
      steps.push(step(FEED_STEP, "warn", "피드에 항목이 없음"));
      return null;
    }
    steps.push(step(FEED_STEP, "ok", `${rows.length}개 항목`));
    return {
      spec: { strategy: "rss", feedUrl: feed.finalUrl },
      rows,
      strategy: "rss",
      feedUrl: feed.finalUrl,
    };
  } catch {
    steps.push(step(FEED_STEP, "warn", "피드 조회 실패"));
    return null;
  }
}

// 상세 페이지로 판단되면 부모 목록 후보를 제시한다.
function parentCandidates(html: string, pageUrl: string): ParentCandidate[] {
  const url = new URL(pageUrl);
  const candidates: ParentCandidate[] = [];

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length >= 2) {
    const parent = `${url.origin}/${parts.slice(0, -1).join("/")}`;
    candidates.push({ label: "상위 경로", url: parent });
  }
  candidates.push({ label: "사이트 홈", url: url.origin });

  // 페이지 내 '목록' 링크 후보
  const { document } = parseHTML(html);
  for (const a of [...document.querySelectorAll("a[href]")]) {
    const label = a.textContent?.trim() ?? "";
    if (/목록|list|전체|더보기|게시판|공지/i.test(label) && label.length < 20) {
      const abs = absolutize(a.getAttribute("href") ?? "", pageUrl);
      if (abs && candidates.every((c) => c.url !== abs)) {
        candidates.push({ label: `링크: ${label}`, url: abs });
      }
    }
    if (candidates.length >= 5) break;
  }
  return candidates.slice(0, 5);
}

export interface ListingAnalysis {
  steps: AnalyzeStep[];
  pageTitle: string | null;
  outcome: AnalyzeOutcome | null; // null = 목록 패턴 없음
  fieldSource: "llm" | "heuristic" | null;
  pageText: string | null; // 힌트 미스 시 텍스트 스냅샷
  staticHtml: string; // parentCandidates용 정적 HTML
  finalUrl: string;
  // robots 금지·fetch 실패. 던지지 않고 돌려줘 호출처가 각자의 응답 형태로 조립한다.
  blocked: { code: ErrorCode; detail: string } | null;
  // 분석이 측정한 수집 프로파일. 목록을 찾지 못했으면 null.
  profile: FetchProfile | null;
  suggested: AnalysisOutcome["suggested"];
  // LLM이 제안하고 페이지의 실제 앵커로 검증된 부모 목록 후보. 폴백 경로에서는 비어 있다.
  listCandidates: ParentCandidate[];
  pageKind: PageKind;
  // 입력된 힌트가 분석한 페이지의 개요에 매칭되는가. 힌트가 없었거나 개요를 만들기 전에
  // 끝난 분석(robots 금지·접근 실패·피드)이면 null. 재분석이 저장된 힌트의 낡음을 알리는 근거다.
  hintMatched: boolean | null;
}

const NO_SUGGESTION: AnalysisOutcome["suggested"] = {
  displayName: "",
  categoryPath: [],
  tagNames: [],
};

const RENDER_STEP = "브라우저 렌더링";
const PROFILE_STEP = "수집 프로파일";
const MS_PER_SECOND = 1000;

const READY_BASIS_LABEL: Record<RenderTimings["readyBy"], string> = {
  selector: "항목 확인",
  networkidle: "네트워크 유휴",
  stabilized: "DOM 안정화",
  timeout: "시간 초과",
};

// 렌더링을 못 해 정적 HTML로 계속할 때 프로파일 측정에 넘기는 값.
// timeout이면 프로파일이 대기 상한을 쓰므로, 측정하지 못한 값을 짧게 믿지 않는다.
const NOT_RENDERED_TIMINGS: RenderTimings = {
  readyMs: 0,
  readyBy: "timeout",
  grewByScroll: false,
};

function seconds(ms: number): string {
  return (ms / MS_PER_SECOND).toFixed(1);
}

interface RenderStage {
  html: string;
  url: string;
  timings: RenderTimings;
}

function renderStep(timings: RenderTimings): AnalyzeStep {
  if (timings.readyBy === "timeout") {
    return step(
      RENDER_STEP,
      "warn",
      `로딩 완료를 확인하지 못했습니다 (${seconds(timings.readyMs)}초 대기)`,
    );
  }
  return step(
    RENDER_STEP,
    "ok",
    `로딩 완료 ${seconds(timings.readyMs)}초 (${READY_BASIS_LABEL[timings.readyBy]})`,
  );
}

// 렌더링이 실패해도 분석을 포기하지 않는다 — 정적 HTML에도 목록이 있는 사이트가 많다.
// 다만 로딩 완료를 보장하지 못한 사실은 단계로 남긴다.
async function renderForAnalysis(
  page: FetchResult,
  originalUrl: string,
  steps: AnalyzeStep[],
): Promise<RenderStage> {
  try {
    // page.finalUrl은 fetch 결과(리다이렉트 반영)이지만 hash fragment는
    // 서버에 전송되지 않아 사라진다. SPA hash 라우팅 사이트(예: sbiz24.kr의
    // #/combinePbancList)는 hash가 있어야 올바른 페이지가 로드되므로
    // 원본 URL의 hash를 보존한 채 렌더링한다.
    const rendered = await renderPage(withHashRoute(page.finalUrl, originalUrl));
    steps.push(renderStep(rendered.timings));
    return { html: rendered.html, url: rendered.finalUrl, timings: rendered.timings };
  } catch (err) {
    if (!(err instanceof AppError)) console.error("[analyze] 렌더링 실패:", err);
    const reason = err instanceof AppError ? err.message : "렌더링에 실패했습니다";
    steps.push(
      step(
        RENDER_STEP,
        "warn",
        `${reason} — 정적 HTML로 계속합니다 (로딩 완료를 보장하지 못함)`,
      ),
    );
    return { html: page.body, url: page.finalUrl, timings: NOT_RENDERED_TIMINGS };
  }
}

function profileStep(profile: FetchProfile): AnalyzeStep {
  if (profile.mode === "feed") return step(PROFILE_STEP, "ok", "피드 수집");
  if (profile.mode === "static") {
    return step(PROFILE_STEP, "ok", "정적 수집으로 충분 (렌더링 불필요)");
  }
  const parts = ["렌더링 필요"];
  if (profile.settleMs !== undefined) parts.push(`대기 ${seconds(profile.settleMs)}초`);
  if (profile.waitForSelector) parts.push("항목 확인 셀렉터 저장");
  return step(PROFILE_STEP, "ok", parts.join(", "));
}

// 같은 스펙을 정적 HTML과 렌더 DOM에 모두 적용해 비교하므로 던질 수 있는 경로가 있다.
// 프로파일 계산 실패가 분석 전체를 죽이면 안 되므로 단계로 남기고 null을 돌려준다.
function measureProfile(
  steps: AnalyzeStep[],
  args: Parameters<typeof buildFetchProfile>[0],
): FetchProfile | null {
  try {
    const profile = buildFetchProfile(args);
    steps.push(profileStep(profile));
    return profile;
  } catch (err) {
    console.error("[analyze] 수집 프로파일 계산 실패:", err);
    steps.push(step(PROFILE_STEP, "warn", "수집 프로파일을 계산하지 못했습니다 — 기존 방식으로 수집"));
    return null;
  }
}

function feedProfile(): FetchProfile {
  return { mode: "feed", measuredAt: new Date().toISOString() };
}

// 렌더링 필요 여부를 프로파일(sources.fetch_profile)과 스펙(spec.render) 양쪽에 남기는 것은
// 중복이 아니라 서로 다른 실패 경로를 덮는 이중 방어다. 지우지 말 것.
// - 프로파일 → 스펙 방향: 등록 시 클라이언트가 보낸 프로파일은 서버가 다시 검증하고, 검증에
//   실패하면 프로파일 없이 등록한다. 그러면 profileFromLegacySpec(spec)이 spec.render로 mode를
//   유도하는데, 이 플래그가 없으면 렌더링이 필요한 소스가 정적 HTML로 0건을 받아 조용히 죽는다
//   (설계서 §1-3이 인용하는 사고).
// - 스펙 → 프로파일 방향: 자가복구가 스펙을 교체하면 spec.render가 사라지지만, 그때는 프로파일이
//   남아 렌더링을 유지한다.
function withRenderFlag(spec: CrawlSpec, profile: FetchProfile | null): CrawlSpec {
  if (profile?.mode === "rendered" && spec.strategy !== "rss") spec.render = true;
  return spec;
}

// robots → 정적 fetch → (피드면 종료) → 렌더링 → 개요 → LLM 해석·합성·검증 → 프로파일.
// 신규 등록(analyzeUrl)과 재분석이 같은 분석을 쓰도록, 중복 확인 앞뒤를 떼어낸 코어다.
export async function analyzeListing(args: {
  userId: string;
  url: string; // 정규화된 URL
  hint?: string;
  // 힌트를 사용자가 입력한 시각. 저장된 힌트를 재사용하는 재분석이 원래 시각을 넘긴다.
  hintSetAt?: string;
  sourceId: string | null; // llm_calls 기록용
  purpose: LlmPurpose;
  allowRepair?: boolean;
}): Promise<ListingAnalysis> {
  const { userId, url, hint, hintSetAt, sourceId, purpose, allowRepair } = args;
  const startedAt = Date.now();
  const steps: AnalyzeStep[] = [];
  const blockedResult = (code: ErrorCode, detail: string): ListingAnalysis => ({
    steps,
    pageTitle: null,
    outcome: null,
    fieldSource: null,
    pageText: null,
    staticHtml: "",
    finalUrl: url,
    blocked: { code, detail },
    profile: null,
    suggested: NO_SUGGESTION,
    listCandidates: [],
    pageKind: "unknown",
    hintMatched: null,
  });

  // 3. robots.txt
  if (!(await robotsAllowed(url))) {
    const detail = "수집이 금지된 경로";
    steps.push(step("robots.txt 확인", "fail", detail));
    return blockedResult(errorCodes.ROBOTS_DISALLOWED, detail);
  }
  steps.push(step("robots.txt 확인", "ok"));

  // 4. 페이지 가져오기
  let page: FetchResult;
  try {
    page = await fetchPage(url);
    steps.push(step("페이지 접근", "ok", `HTTP ${page.status}`));
  } catch (err) {
    if (err instanceof AppError) {
      steps.push(step("페이지 접근", "fail", err.message));
      return blockedResult(err.code, err.message);
    }
    throw err;
  }

  const hostname = new URL(page.finalUrl).hostname;

  // 5. 피드 조기 종료
  const feed = await detectFeed(page, steps);
  if (feed) {
    const profile = feedProfile();
    steps.push(profileStep(profile));
    return {
      steps,
      pageTitle: extractTitle(page.body) ?? hostname,
      outcome: feed,
      fieldSource: "heuristic",
      pageText: null,
      staticHtml: page.body,
      finalUrl: page.finalUrl,
      blocked: null,
      profile,
      suggested: NO_SUGGESTION,
      listCandidates: [],
      pageKind: "list",
      hintMatched: null,
    };
  }

  // 6. 렌더링 → 개요 → 해석
  const rendered = await renderForAnalysis(page, url, steps);
  const outline = buildPageOutline(rendered.html);
  const analysis = await runAnalysis({
    html: rendered.html,
    pageUrl: rendered.url,
    outline,
    hint,
    hintSetAt,
    userId,
    sourceId,
    purpose,
    allowRepair,
    startedAt,
  });
  steps.push(...analysis.steps);

  // 7. 프로파일
  const { spec } = analysis;
  const profile = spec
    ? measureProfile(steps, {
        staticHtml: page.body,
        renderedHtml: rendered.html,
        spec,
        timings: rendered.timings,
        strategy: analysis.strategy,
        pageUrl: rendered.url,
      })
    : null;
  const outcome: AnalyzeOutcome | null = spec
    ? {
        spec: withRenderFlag(spec, profile),
        rows: analysis.rows,
        strategy: analysis.strategy,
        feedUrl: analysis.feedUrl,
      }
    : null;

  // 힌트가 있는데 현재 페이지에서 매칭되지 않거나 목록을 못 찾았으면, 사용자가 새 힌트를
  // 직접 고를 수 있도록 렌더된 페이지의 텍스트를 함께 준다.
  const hintMatched = hint ? hintMatchesOutline(outline.text, hint) : null;
  const hintMissed = Boolean(hint) && (!outcome || hintMatched === false);

  return {
    steps,
    pageTitle: extractTitle(page.body) ?? extractTitle(rendered.html) ?? analysis.pageTitle ?? hostname,
    outcome,
    fieldSource: analysis.fieldSource,
    pageText: hintMissed ? toPageText(rendered.html) : null,
    staticHtml: page.body,
    finalUrl: page.finalUrl,
    blocked: null,
    profile,
    suggested: analysis.suggested,
    listCandidates: analysis.listCandidates,
    pageKind: analysis.pageKind,
    hintMatched,
  };
}

const MAX_PARENT_CANDIDATES = 5;

// LLM이 고른 후보를 앞에 두고, URL 경로 자르기 후보로 채운다. LLM 후보는 페이지의
// 실제 앵커로 검증된 것이라 신뢰할 수 있고, 경로 후보는 LLM이 아무것도 못 골랐을 때의 안전망이다.
function mergeCandidates(
  preferred: ParentCandidate[],
  fallback: ParentCandidate[],
): ParentCandidate[] {
  const merged = new Map<string, ParentCandidate>();
  for (const c of [...preferred, ...fallback]) {
    if (!merged.has(c.url)) merged.set(c.url, c);
  }
  return [...merged.values()].slice(0, MAX_PARENT_CANDIDATES);
}

function suggestedOf(listing: ListingAnalysis): AnalyzeResult["suggested"] {
  return {
    ...listing.suggested,
    displayName: listing.suggested.displayName || (listing.pageTitle ?? ""),
  };
}

export async function analyzeUrl(
  userId: string,
  rawUrl: string,
  hint?: string,
): Promise<AnalyzeResult> {
  const steps: AnalyzeStep[] = [];
  const db = getDb();

  // 1. URL 검증·정규화
  let normalized: string;
  try {
    normalized = normalizeUrl(rawUrl);
    assertPublicUrl(normalized);
    steps.push(step("URL 검증", "ok"));
  } catch (err) {
    if (err instanceof AppError) {
      steps.push(step("URL 검증", "fail", err.message));
      return {
        steps,
        outcome: "error",
        normalizedUrl: null,
        pageTitle: null,
        candidates: [],
        existingSourceId: null,
        preview: null,
        suggested: { displayName: "", categoryPath: [], tagNames: [] },
        pageText: null,
        errorCode: err.code,
        fieldSource: null,
      };
    }
    throw err;
  }

  // 2. 기존 소스 중복 확인
  const { rows: existing } = await db.query<{ id: string }>(
    `select id from myportal.sources where normalized_url = $1`,
    [normalized],
  );
  if (existing[0]) {
    steps.push(step("기존 소스 확인", "ok", "이미 등록된 소스"));
    return {
      steps,
      outcome: "exists",
      normalizedUrl: normalized,
      pageTitle: null,
      candidates: [],
      existingSourceId: existing[0].id,
      preview: null,
      suggested: { displayName: "", categoryPath: [], tagNames: [] },
      pageText: null,
      errorCode: errorCodes.ALREADY_SUBSCRIBED,
      fieldSource: null,
    };
  }
  steps.push(step("기존 소스 확인", "ok", "신규 소스"));

  // 3~7. robots → 가져오기 → (피드 종료) → 렌더링 → LLM 해석·합성·검증 → 프로파일
  const listing = await analyzeListing({
    userId,
    url: normalized,
    hint,
    sourceId: null,
    purpose: "analyze-fields",
  });
  steps.push(...listing.steps);

  if (listing.blocked) {
    return {
      steps,
      outcome:
        listing.blocked.code === errorCodes.ROBOTS_DISALLOWED
          ? "link-only"
          : "error",
      normalizedUrl: normalized,
      pageTitle: null,
      candidates: [],
      existingSourceId: null,
      preview: null,
      suggested: { displayName: "", categoryPath: [], tagNames: [] },
      pageText: null,
      errorCode: listing.blocked.code,
      fieldSource: null,
    };
  }

  const { outcome, pageTitle } = listing;
  if (!outcome) {
    // 목록을 못 찾으면 상세 페이지로 보고 부모 후보 제시
    const candidates = mergeCandidates(
      listing.listCandidates,
      parentCandidates(listing.staticHtml, listing.finalUrl),
    );
    steps.push(
      step("페이지 유형 판정", "warn", "목록 패턴 없음 — 상세 페이지로 추정"),
    );
    return {
      steps,
      outcome: "detail",
      normalizedUrl: normalized,
      pageTitle,
      candidates,
      existingSourceId: null,
      preview: null,
      suggested: suggestedOf(listing),
      pageText: listing.pageText,
      errorCode: errorCodes.PAGE_TYPE_UNKNOWN,
      fieldSource: null,
    };
  }

  const fields = fieldsFromRows(outcome.rows, outcome.spec);
  steps.push(step("페이지 유형 판정", "ok", "목록 페이지"));

  return {
    steps,
    outcome: "list",
    normalizedUrl: normalized,
    pageTitle,
    candidates: [],
    existingSourceId: null,
    preview: {
      fields,
      rows: outcome.rows.slice(0, 10).map((r) => ({
        title: r.title,
        link: r.link,
        published: r.publishedAt,
        ...r.attrs,
      })),
      fetchStrategy: outcome.strategy,
      spec: outcome.spec,
      profile: listing.profile,
    },
    suggested: suggestedOf(listing),
    pageText: listing.pageText,
    errorCode: null,
    fieldSource: listing.fieldSource,
  };
}

function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const og = html.match(
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
  );
  const raw = (og?.[1] ?? m?.[1] ?? "").trim();
  return raw ? decodeEntities(raw).slice(0, 200) : null;
}

// fetchPage의 결과 URL(finalUrl)에는 hash fragment가 없다 — 서버에 전송되지
// 않기 때문이다. SPA hash 라우팅 사이트는 hash로 페이지를 식별하므로, 원본 URL에
// SPA 라우트 hash(#/... 또는 #!/...)가 있으면 finalUrl에 복원한다.
// 일반 #anchor는 복원하지 않는다.
function withHashRoute(finalUrl: string, originalUrl: string): string {
  try {
    const orig = new URL(originalUrl);
    if (!orig.hash) return finalUrl;
    if (!/^#\//.test(orig.hash) && !/^#!\//.test(orig.hash)) return finalUrl;
    const final = new URL(finalUrl);
    final.hash = orig.hash;
    return final.toString();
  } catch {
    return finalUrl;
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}
