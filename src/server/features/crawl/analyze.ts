import type {
  AnalyzeResult,
  AnalyzeStep,
  ParentCandidate,
  SourceField,
} from "@myportal/api-contracts";
import { getDb } from "../../config/db";
import { AppError, errorCodes } from "../../errors/error-codes";
import { fetchPage } from "./fetcher";
import { renderPage } from "./render";
import { robotsAllowed } from "./robots";
import {
  applySpec,
  discoverFeedUrl,
  generateSpec,
  looksLikeFeed,
  parseFeed,
  parseJsonLdList,
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

// 추출 샘플에서 필드 목록을 만든다. title/link/published는 고정 역할이고
// 나머지 키는 attrs에 들어간다.
export function fieldsFromRows(rows: ExtractedRow[]): SourceField[] {
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
    fields.push({
      key,
      label: key,
      type: guessFieldType(sample),
      role: key === "deadline" ? "deadline" : "none",
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

interface AnalyzeOutcome {
  spec: CrawlSpec | null;
  rows: ExtractedRow[];
  strategy: "rss" | "structured" | "html";
  feedUrl: string | null;
}

interface Detection {
  outcome: AnalyzeOutcome | null;
  // 힌트가 지정됐는데 그 문자열을 포함한 목록을 못 찾은 경우 true —
  // JS 렌더링 재시도의 트리거로 사용한다.
  hintMissed: boolean;
}

// 페이지에서 목록 추출 전략을 순서대로 시도한다: (힌트) → RSS → JSON-LD → DOM 휴리스틱.
async function detectExtraction(
  html: string,
  contentType: string,
  pageUrl: string,
  steps: AnalyzeStep[],
  hint?: string,
): Promise<Detection> {
  // 사용자가 목록 항목 텍스트를 직접 지정했으면 그 영역을 우선 시도한다.
  // 명시된 사용자 의도가 자동 추정보다 우선한다.
  if (hint) {
    const hinted = generateSpec(html, pageUrl, hint);
    if (hinted?.hintMatched) {
      steps.push(
        step("힌트 영역 선택", "ok", `${hinted.rows.length}개 항목`),
      );
      return {
        outcome: {
          spec: hinted.spec,
          rows: hinted.rows,
          strategy: "html",
          feedUrl: null,
        },
        hintMissed: false,
      };
    }
    steps.push(
      step(
        "힌트 영역 선택",
        "warn",
        "힌트 문자열을 포함한 목록을 찾지 못했습니다 — 자동 추정으로 진행",
      ),
    );
  }

  if (looksLikeFeed(contentType, html)) {
    const rows = parseFeed(html, pageUrl);
    if (rows.length > 0) {
      steps.push(step("피드 형식 감지", "ok", `${rows.length}개 항목`));
      return {
        outcome: {
          spec: { strategy: "rss" },
          rows,
          strategy: "rss",
          feedUrl: pageUrl,
        },
        hintMissed: Boolean(hint),
      };
    }
  }

  const feedUrl = discoverFeedUrl(html, pageUrl);
  if (feedUrl && feedUrl !== pageUrl) {
    try {
      const feed = await fetchPage(feedUrl);
      if (looksLikeFeed(feed.contentType, feed.body)) {
        const rows = parseFeed(feed.body, feed.finalUrl);
        if (rows.length > 0) {
          steps.push(
            step("RSS/Atom 피드 발견", "ok", `${rows.length}개 항목`),
          );
          return {
            outcome: {
              spec: { strategy: "rss", feedUrl: feed.finalUrl },
              rows,
              strategy: "rss",
              feedUrl: feed.finalUrl,
            },
            hintMissed: Boolean(hint),
          };
        }
      }
    } catch {
      steps.push(step("RSS/Atom 피드 발견", "warn", "피드 조회 실패"));
    }
  } else {
    steps.push(step("RSS/Atom 피드 발견", "warn", "피드 없음"));
  }

  const jsonLd = parseJsonLdList(html, pageUrl);
  if (jsonLd && jsonLd.length >= 3) {
    steps.push(
      step("구조화 데이터(JSON-LD) 감지", "ok", `${jsonLd.length}개 항목`),
    );
    return {
      outcome: {
        spec: { strategy: "structured" },
        rows: jsonLd,
        strategy: "structured",
        feedUrl: null,
      },
      hintMissed: Boolean(hint),
    };
  }
  steps.push(step("구조화 데이터(JSON-LD) 감지", "warn", "목록 없음"));

  const generated = generateSpec(html, pageUrl);
  if (generated && generated.rows.length >= 3) {
    steps.push(
      step("HTML 목록 패턴 추출", "ok", `${generated.rows.length}개 항목`),
    );
    return {
      outcome: {
        spec: generated.spec,
        rows: generated.rows,
        strategy: "html",
        feedUrl: null,
      },
      hintMissed: Boolean(hint),
    };
  }
  steps.push(step("HTML 목록 패턴 추출", "fail", "반복 목록을 찾지 못함"));
  return { outcome: null, hintMissed: Boolean(hint) };
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

export async function analyzeUrl(
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
        errorCode: err.code,
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
      errorCode: errorCodes.ALREADY_SUBSCRIBED,
    };
  }
  steps.push(step("기존 소스 확인", "ok", "신규 소스"));

  // 3. robots.txt
  if (!(await robotsAllowed(normalized))) {
    steps.push(step("robots.txt 확인", "fail", "수집이 금지된 경로"));
    return {
      steps,
      outcome: "link-only",
      normalizedUrl: normalized,
      pageTitle: null,
      candidates: [],
      existingSourceId: null,
      preview: null,
      suggested: { displayName: "", categoryPath: [], tagNames: [] },
      errorCode: errorCodes.ROBOTS_DISALLOWED,
    };
  }
  steps.push(step("robots.txt 확인", "ok"));

  // 4. 페이지 가져오기
  let page;
  try {
    page = await fetchPage(normalized);
    steps.push(step("페이지 접근", "ok", `HTTP ${page.status}`));
  } catch (err) {
    if (err instanceof AppError) {
      steps.push(step("페이지 접근", "fail", err.message));
      return {
        steps,
        outcome: "error",
        normalizedUrl: normalized,
        pageTitle: null,
        candidates: [],
        existingSourceId: null,
        preview: null,
        suggested: { displayName: "", categoryPath: [], tagNames: [] },
        errorCode: err.code,
      };
    }
    throw err;
  }

  const pageTitle = extractTitle(page.body) ?? new URL(page.finalUrl).hostname;

  // 5. 추출 전략 감지
  const detection = await detectExtraction(
    page.body,
    page.contentType,
    page.finalUrl,
    steps,
    hint,
  );
  let outcome = detection.outcome;

  // 6. JS로 목록을 채우는 사이트: 일반 HTML에서 목록을 못 찾았거나
  // 힌트 문자열이 없으면 헤드리스 브라우저로 렌더링해 한 번 더 시도한다.
  if (!outcome || detection.hintMissed) {
    try {
      const rendered = await renderPage(page.finalUrl);
      steps.push(
        step("브라우저 렌더링", "ok", "렌더링된 DOM으로 다시 분석"),
      );
      const retried = await detectExtraction(
        rendered.html,
        "text/html",
        rendered.finalUrl,
        steps,
        hint,
      );
      if (retried.outcome) {
        // 렌더링이 필요했음을 스펙에 기록해 이후 수집도 브라우저로 한다.
        // rss 전략은 피드 자체를 fetch하므로 렌더링 표시가 불필요하다.
        if (retried.outcome.spec && retried.outcome.spec.strategy !== "rss") {
          retried.outcome.spec.render = true;
        }
        outcome = retried.outcome;
      }
    } catch (err) {
      steps.push(
        step(
          "브라우저 렌더링",
          "warn",
          err instanceof AppError ? err.message : "렌더링에 실패했습니다",
        ),
      );
    }
  }

  if (!outcome) {
    // 목록을 못 찾으면 상세 페이지로 보고 부모 후보 제시
    const candidates = parentCandidates(page.body, page.finalUrl);
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
      suggested: { displayName: pageTitle, categoryPath: [], tagNames: [] },
      errorCode: errorCodes.PAGE_TYPE_UNKNOWN,
    };
  }

  const fields = fieldsFromRows(outcome.rows);
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
    },
    suggested: { displayName: pageTitle, categoryPath: [], tagNames: [] },
    errorCode: null,
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

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}
