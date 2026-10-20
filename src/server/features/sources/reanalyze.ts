import type {
  ApplySpecRequest,
  ApplySpecResponse,
  ReanalyzeResult,
  SourceField,
} from "@myportal/api-contracts";
import { getDb } from "../../config/db";
import { AppError, errorCodes, validationError } from "../../errors/error-codes";
import { analyzeListing, fieldsFromRows } from "../crawl/analyze";
import { extractRows } from "../crawl/collector";
import type { CrawlSpec, ExtractedRow } from "../crawl/extract";
import { fetchPage } from "../crawl/fetcher";
import { renderPage } from "../crawl/render";
import { reanalyzeSql } from "./reanalyze.sql";
import { findSubscribedSource } from "./sources";
import { sourcesSql } from "./sources.sql";

const PREVIEW_ROW_LIMIT = 10;
const SOURCE_STATUS_OK = "ok";
const SOURCE_STATUS_PAUSED = "pause";
const SPEC_CREATED_BY_MANUAL = "manual";
const ACTION_APPLY_SPEC = "apply-spec";

interface FieldRow {
  key: string;
  label: string;
  type: string;
  role: string;
  sort_order: number;
  visible: boolean;
}

function toSourceField(f: FieldRow): SourceField {
  return {
    key: f.key,
    label: f.label,
    type: f.type as SourceField["type"],
    role: f.role as SourceField["role"],
    visible: f.visible,
    sortOrder: f.sort_order,
  };
}

// 저장된 활성 스펙의 hint. 목록 영역을 다시 같은 곳으로 찾게 하는 기본값이다.
// pg는 jsonb를 이미 파싱된 객체로 반환하므로 문자열일 때만 JSON.parse한다.
function storedHintOf(spec: unknown): string | undefined {
  const parsed: unknown = typeof spec === "string" ? JSON.parse(spec) : spec;
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const hint = (parsed as { hint?: unknown }).hint;
  return typeof hint === "string" && hint.length > 0 ? hint : undefined;
}

// 등록된 소스를 다시 분석해 미리보기를 만든다. 조회만 하고 저장하지 않는다 —
// 미리보기 단계에서 DB가 바뀌지 않아야 사용자의 '취소'가 되돌릴 것 없이 공짜가 된다.
// (LLM 호출 이력 llm_calls는 analyzeListing 안에서 기록된다.)
export async function reanalyzeSource(
  userId: string,
  sourceId: string,
  hint?: string,
): Promise<ReanalyzeResult> {
  // 권한 판정은 sources.ts와 같은 함수를 쓴다 — 소스 없음 404,
  // 구독 안 함 403. 규칙이 엔드포인트마다 갈리면 안 된다.
  const { source } = await findSubscribedSource(userId, sourceId);
  const db = getDb();

  const [activeSpec, fields] = await Promise.all([
    db.query<{ spec: unknown }>(sourcesSql.latestActiveSpec, [sourceId]),
    db.query<FieldRow>(sourcesSql.fieldsForSource, [sourceId]),
  ]);

  const effectiveHint =
    hint ?? (activeSpec.rows[0] ? storedHintOf(activeSpec.rows[0].spec) : undefined);

  const listing = await analyzeListing({
    userId,
    url: String(source.normalized_url ?? source.url),
    hint: effectiveHint,
    sourceId,
    // 보강·구제 양쪽에 rebuild가 그대로 쓰이도록 analyze-fields를 넘기지 않는다.
    purpose: "rebuild",
  });

  const currentFields = fields.rows.map(toSourceField);
  const base = {
    steps: listing.steps,
    pageTitle: listing.pageTitle,
    currentFields,
    pageText: listing.pageText,
  };

  if (listing.blocked) {
    return {
      ...base,
      outcome:
        listing.blocked.code === errorCodes.ROBOTS_DISALLOWED ? "link-only" : "error",
      preview: null,
      fieldSource: null,
      errorCode: listing.blocked.code,
    };
  }

  const { outcome } = listing;
  if (!outcome) {
    return {
      ...base,
      steps: [
        ...base.steps,
        { label: "페이지 유형 판정", status: "warn", detail: "목록 패턴 없음" },
      ],
      outcome: "detail",
      preview: null,
      fieldSource: null,
      errorCode: errorCodes.PAGE_TYPE_UNKNOWN,
    };
  }

  return {
    ...base,
    steps: [...base.steps, { label: "페이지 유형 판정", status: "ok", detail: "목록 페이지" }],
    outcome: "list",
    preview: {
      fields: fieldsFromRows(outcome.rows, outcome.spec),
      // analyzeUrl과 같은 모양 — 같은 FieldPreviewTable이 두 응답을 그대로 그린다.
      rows: outcome.rows.slice(0, PREVIEW_ROW_LIMIT).map((r) => ({
        title: r.title,
        link: r.link,
        published: r.publishedAt,
        ...r.attrs,
      })),
      fetchStrategy: outcome.strategy,
      spec: outcome.spec,
    },
    fieldSource: listing.fieldSource,
    errorCode: null,
  };
}

// ── 적용 ────────────────────────────────────────────────

// zod의 z.unknown()은 null·배열·원시값도 통과시키므로 여기서 직접 걸러낸다.
// 목록을 못 찾은 재분석(preview: null)이 그대로 적용으로 올 수 있기 때문이다.
function assertSpecObject(spec: unknown): asserts spec is Record<string, unknown> {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    throw validationError("유효한 추출 명세가 아닙니다.");
  }
}

// insertField가 (source_id, key) 업서트라 중복 key는 오류 없이 하나가 다른 하나를 덮는다.
function assertUniqueFieldKeys(fields: readonly SourceField[]): void {
  const keys = new Set(fields.map((f) => f.key));
  if (keys.size !== fields.length) {
    throw validationError("필드 키가 중복되었습니다.");
  }
}

// 페이지 조회·렌더 실패는 null로 돌려준다. 스펙은 유효할 수 있으므로
// 호출부가 백필만 건너뛰고 저장은 계속한다.
async function fetchAndExtract(
  source: Record<string, unknown>,
  spec: Record<string, unknown>,
  fetchStrategy: ApplySpecRequest["fetchStrategy"],
): Promise<ExtractedRow[] | null> {
  const url = String(source.normalized_url ?? source.url);
  let html: string;
  let contentType: string;
  let finalUrl: string;
  try {
    if (spec.render === true) {
      const page = await renderPage(url);
      ({ html, finalUrl } = page);
      contentType = "text/html";
    } else {
      const page = await fetchPage(url);
      ({ body: html, contentType, finalUrl } = page);
    }
  } catch {
    return null;
  }

  // RSS는 새 스펙이 가리키는 피드를 우선한다. 소스에 feed_url이 아직 없을 수 있다.
  const feedUrl =
    typeof spec.feedUrl === "string" ? spec.feedUrl : ((source.feed_url as string | null) ?? null);
  // 전략별 분기를 여기서 다시 쓰지 않는다 — 수집 경로와 어긋나지 않게 extractRows를 그대로 쓴다.
  return extractRows(
    { url, fetch_strategy: fetchStrategy, feed_url: feedUrl },
    spec as unknown as CrawlSpec,
    html,
    contentType,
    finalUrl,
  );
}

// 재분석 미리보기에서 사용자가 확정한 스펙·필드를 저장한다.
// 클라이언트가 보낸 spec을 신뢰하지 않고 추출을 다시 돌려 검증한 뒤에만 저장한다.
export async function applySpecForSource(
  userId: string,
  sourceId: string,
  input: ApplySpecRequest,
): Promise<ApplySpecResponse> {
  const { source } = await findSubscribedSource(userId, sourceId);

  const { spec } = input;
  assertSpecObject(spec);
  assertUniqueFieldKeys(input.fields);

  // 외부 I/O는 트랜잭션 밖에서 끝낸다 — 연결을 쥔 채 네트워크를 기다리지 않기 위함.
  const extracted = await fetchAndExtract(source, spec, input.fetchStrategy);
  if (extracted !== null && extracted.length === 0) {
    throw new AppError(
      errorCodes.EXTRACTION_FAILED,
      "이 명세로 목록을 추출할 수 없습니다.",
      422,
    );
  }
  const backfillFailed = extracted === null;

  // repairSpec이 이후 자가복구에서 같은 영역을 다시 찾도록 hint를 스펙에 싣는다.
  const specToSave = input.hint ? { ...spec, hint: input.hint } : spec;
  // 일시정지는 사용자의 의도이므로 적용이 풀어서는 안 된다.
  const status = source.status === SOURCE_STATUS_PAUSED ? SOURCE_STATUS_PAUSED : SOURCE_STATUS_OK;
  // 재분석이 새로 발견한 피드는 spec.feedUrl에만 있다. sources.feed_url에 옮기지
  // 않으면 수집 경로가 HTML 페이지를 피드로 읽어 영구히 0건을 반환한다.
  const discoveredFeedUrl =
    typeof (spec as { feedUrl?: unknown }).feedUrl === "string"
      ? (spec as { feedUrl: string }).feedUrl
      : null;

  return getDb().transaction(async (tx) => {
    const { rows: versionRows } = await tx.query<{ v: number }>(
      reanalyzeSql.maxSpecVersion,
      [sourceId],
    );
    const version = Number(versionRows[0]?.v ?? 0) + 1;

    await tx.query(sourcesSql.deactivateSpecs, [sourceId]);
    await tx.query(sourcesSql.insertSpec, [
      sourceId,
      version,
      JSON.stringify(specToSave),
      SPEC_CREATED_BY_MANUAL,
    ]);
    for (const f of input.fields) {
      await tx.query(sourcesSql.insertField, [
        sourceId,
        f.key,
        f.label,
        f.type,
        f.role,
        f.sortOrder,
        f.visible,
      ]);
    }

    // 백필 자리(스펙 §5 3-d): `extracted` 행으로 기존 항목을 갱신·삽입하고
    // 적용자에게 읽음 마킹한다. backfillFailed면 extracted가 null이라 건너뛴다.
    const backfill = { backfilled: 0, inserted: 0 };

    await tx.query(reanalyzeSql.updateSourceAfterApply, [
      sourceId,
      input.fetchStrategy,
      status,
      discoveredFeedUrl,
    ]);
    await tx.query(sourcesSql.insertManualAction, [userId, sourceId, ACTION_APPLY_SPEC]);

    return {
      version,
      fieldsSaved: input.fields.length,
      ...backfill,
      backfillFailed,
    };
  });
}
