import type { SourceDetail, Subscription } from "@myportal/api-contracts";
import type { DatabaseClient } from "@ttoltori/database";
import { getDb } from "../../config/db";
import { AppError, errorCodes } from "../../errors/error-codes";
import { mapItem, type ItemRow } from "../desk/desk";
import { deskSql } from "../desk/desk.sql";
import { collectSource } from "../crawl/collector";
import {
  fetchProfileSchema,
  profileFromLegacySpec,
  type FetchProfile,
} from "../crawl/analyze/profile";
import type { CrawlSpec } from "../crawl/extract";
import { sourcesSql } from "./sources.sql";

interface SubRow {
  id: string;
  source_id: string;
  display_name: string;
  category_id: string | null;
  paused: boolean;
  url: string;
  fetch_strategy: string;
  status: string;
  last_success_at: string | null;
  interval_minutes: number;
}

// 소스 상세는 '구독' 단위가 아니라 '소스' 단위로 조회한다.
// 이 사용자가 해당 소스를 구독 중인지는 subscriptionForSource로 확인한다.
// 소스 단위 조작(상세·수집·재분석·적용)의 공통 권한 판정.
// 소스가 없으면 404, 있지만 구독하지 않았으면 403 — 다섯 곳이 같은 규칙을
// 쓰므로 한 곳에 둔다(CLAUDE.md §21).
export async function findSubscribedSource(
  userId: string,
  sourceId: string,
): Promise<{ sub: { id: string; display_name: string; category_id: string | null; paused: boolean }; source: Record<string, unknown> }> {
  const db = getDb();
  const { rows: subs } = await db.query<{
    id: string; display_name: string; category_id: string | null; paused: boolean;
  }>(sourcesSql.subscriptionForSource, [sourceId, userId]);
  const { rows: src } = await db.query<Record<string, unknown>>(
    sourcesSql.findById,
    [sourceId],
  );
  if (!src[0]) {
    throw new AppError(errorCodes.SOURCE_NOT_FOUND, "소스를 찾을 수 없습니다.", 404);
  }
  if (!subs[0]) {
    throw new AppError(errorCodes.FORBIDDEN, "구독하지 않은 소스입니다.", 403);
  }
  return { sub: subs[0], source: src[0] };
}

async function subscriptionShape(
  userId: string,
  sourceId: string,
  sub: { id: string; display_name: string; category_id: string | null; paused: boolean },
  source: Record<string, unknown>,
): Promise<Subscription> {
  const db = getDb();
  const [tags, count, fields, activeSpec] = await Promise.all([
    db.query<{ tag_id: string }>(
      `select tag_id from myportal.subscription_tags where subscription_id = $1`,
      [sub.id],
    ),
    db.query<{ c: number }>(
      `select count(*)::int as c from myportal.items
       where source_id = $1 and is_baseline = false
         and collected_at > now() - interval '7 days'`,
      [sourceId],
    ),
    db.query<{
      key: string; label: string; type: string; role: string;
      sort_order: number; visible: boolean;
    }>(sourcesSql.fieldsForSource, [sourceId]),
    db.query<{ spec: unknown }>(sourcesSql.latestActiveSpec, [sourceId]),
  ]);
  return {
    id: sub.id,
    sourceId,
    displayName: sub.display_name,
    url: String(source.url),
    categoryId: sub.category_id,
    tagIds: tags.rows.map((t) => t.tag_id),
    fetchStrategy: source.fetch_strategy as Subscription["fetchStrategy"],
    rendered: isRenderedSource(source as { fetch_profile: unknown }, activeSpec.rows[0]?.spec ?? null),
    status: source.status as Subscription["status"],
    lastSuccessAt: source.last_success_at
      ? new Date(String(source.last_success_at)).toISOString()
      : null,
    new7d: count.rows[0]?.c ?? 0,
    intervalMinutes: Number(source.interval_minutes),
    paused: sub.paused,
    fields: fields.rows.map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type as Subscription["fields"][number]["type"],
      role: f.role as Subscription["fields"][number]["role"],
      visible: f.visible,
      sortOrder: f.sort_order,
    })),
  };
}

export async function getSourceDetail(
  userId: string,
  sourceId: string,
): Promise<SourceDetail> {
  const db = getDb();
  const { sub, source } = await findSubscribedSource(userId, sourceId);
  const subscription = await subscriptionShape(userId, sourceId, sub, source);

  const [versions, runs, itemsRes, dlFields] = await Promise.all([
    db.query<{
      version: number; spec: unknown; created_by: string;
      active: boolean; created_at: string;
    }>(sourcesSql.specVersions, [sourceId]),
    db.query<{
      id: string; ran_at: string; strategy: string;
      duration_ms: number; new_count: number; result: string;
    }>(sourcesSql.recentRuns, [sourceId]),
    db.query<ItemRow>(
      `select i.id, i.source_id, i.title, i.url, i.published_at, i.collected_at,
              i.excerpt, i.attrs, i.is_baseline, i.cluster_id,
              coalesce(st.read, false) as read,
              coalesce(st.starred, false) as starred,
              rm.rule_id, rm.action as rule_action, kr.name as rule_name
       from myportal.items i
       left join myportal.item_states st
         on st.item_id = i.id and st.user_id = $1
       left join myportal.item_rule_matches rm
         on rm.item_id = i.id and rm.user_id = $1
       left join myportal.keyword_rules kr on kr.id = rm.rule_id
       where i.source_id = $2
       order by i.collected_at desc
       limit 30`,
      [userId, sourceId],
    ),
    db.query<{ source_id: string; key: string }>(deskSql.deadlineFields),
  ]);
  const dlMap = new Map<string, string>();
  for (const f of dlFields.rows) dlMap.set(f.source_id, f.key);

  const fields = await db.query<{
    key: string; label: string; type: string; role: string;
    sort_order: number; visible: boolean;
  }>(sourcesSql.fieldsForSource, [sourceId]);

  return {
    subscription,
    fields: fields.rows.map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type as Subscription["fields"][number]["type"],
      role: f.role as Subscription["fields"][number]["role"],
      visible: f.visible,
      sortOrder: f.sort_order,
    })),
    versions: versions.rows.map((v) => ({
      version: v.version,
      createdBy: v.created_by,
      createdAt: new Date(v.created_at).toISOString(),
      active: v.active,
      spec: typeof v.spec === "string" ? JSON.parse(v.spec) : v.spec,
    })),
    runs: runs.rows.map((r) => ({
      id: r.id,
      ranAt: new Date(r.ran_at).toISOString(),
      strategy: r.strategy as SourceDetail["runs"][number]["strategy"],
      durationMs: r.duration_ms,
      newCount: r.new_count,
      result: r.result,
    })),
    recentItems: itemsRes.rows.map((r) => mapItem(r, dlMap)),
  };
}

export async function collectNow(
  userId: string,
  sourceId: string,
): Promise<{ newCount: number; runId: string }> {
  await findSubscribedSource(userId, sourceId);
  const res = await collectSource(sourceId, { manual: true, userId });
  return { newCount: res.newCount, runId: res.runId };
}

// 수집 프로파일은 스펙과 수명이 달라 sources.fetch_profile에 따로 둔다.
// 분석 트랜잭션 안에서 스펙 저장과 함께 커밋되도록 tx를 받을 수 있다.
export async function saveFetchProfile(
  sourceId: string,
  profile: FetchProfile,
  tx?: DatabaseClient,
): Promise<void> {
  const db = tx ?? getDb();
  await db.query(sourcesSql.updateFetchProfile, [sourceId, JSON.stringify(profile)]);
}

// 폴백이 쓰였는지와 그 이유. 호출자가 "조용히 폴백"과 "알려야 하는 폴백"을 구분하게 한다.
//  - none: 저장된 프로파일이 스키마를 통과했다.
//  - empty: 저장된 값이 비었다(null/undefined/키 없는 객체). 마이그레이션 직후의 정상 상태.
//  - corrupt: 값이 있는데 파싱이나 스키마 검증에 실패했다. 운영자가 알아야 한다.
export type FetchProfileFallback = "none" | "empty" | "corrupt";

export interface LoadedFetchProfile {
  profile: FetchProfile;
  fallback: FetchProfileFallback;
}

function isEmptyStoredValue(raw: unknown): boolean {
  if (raw == null) return true;
  // 배열은 typeof가 object라도 빈 프로파일이 아니라 형태가 틀린 값이다.
  return (
    typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).length === 0
  );
}

// 저장된 값이 비었거나(마이그레이션 직후 '{}') 스키마에 맞지 않으면 예외 대신
// 레거시 폴백을 쓴다. 손으로 넣은 값이나 구버전 형태가 수집 전체를 깨뜨리면 안 되고,
// 폴백은 spec.render를 따르므로 기존 동작이 유지된다.
// 폴백 여부 판정을 여기서 함께 하는 이유: 호출자가 따로 재판정하면 폴백이 쓰이는 조건과
// 로그를 남기는 조건이 어긋날 수 있다.
export function loadFetchProfile(
  row: { fetch_profile: unknown },
  spec: CrawlSpec | null,
): LoadedFetchProfile {
  // pg는 jsonb를 이미 파싱된 객체로 반환하므로 문자열일 때만 JSON.parse한다.
  let raw = row.fetch_profile;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return { profile: profileFromLegacySpec(spec), fallback: "corrupt" };
    }
  }
  if (isEmptyStoredValue(raw)) {
    return { profile: profileFromLegacySpec(spec), fallback: "empty" };
  }
  const parsed = fetchProfileSchema.safeParse(raw);
  return parsed.success
    ? { profile: parsed.data, fallback: "none" }
    : { profile: profileFromLegacySpec(spec), fallback: "corrupt" };
}

// jsonb 컬럼은 pg가 객체로 주지만 문자열로 올 수도 있어 둘 다 받는다. 스펙에서 폴백 판정에
// 쓰는 건 strategy/render뿐이라 객체 여부만 확인하고, 아니면 스펙 없음으로 본다.
function toCrawlSpec(raw: unknown): CrawlSpec | null {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as CrawlSpec)
    : null;
}

// 화면의 "렌더링" 필터가 쓰는 값. 렌더링 필요 여부는 fetch_strategy가 아니라 프로파일의 mode가
// 담으므로(분석은 'rendered' 전략을 더 이상 내지 않는다) 수집기와 같은 loadFetchProfile로
// 판정한다. 판정 규칙을 따로 복제하면 프로파일이 비거나 손상된 기존 소스에서 수집기와 화면이
// 어긋난다.
export function isRenderedSource(
  row: { fetch_profile: unknown },
  spec: unknown,
): boolean {
  return loadFetchProfile(row, toCrawlSpec(spec)).profile.mode === "rendered";
}
