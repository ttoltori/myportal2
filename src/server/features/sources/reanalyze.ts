import type { ReanalyzeResult, SourceField } from "@myportal/api-contracts";
import { getDb } from "../../config/db";
import { errorCodes } from "../../errors/error-codes";
import { analyzeListing, fieldsFromRows } from "../crawl/analyze";
import { findSubscribedSource } from "./sources";
import { sourcesSql } from "./sources.sql";

const PREVIEW_ROW_LIMIT = 10;

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
