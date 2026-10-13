import type { SourceDetail, Subscription } from "@myportal/api-contracts";
import { getDb } from "../../config/db";
import { AppError, errorCodes } from "../../errors/error-codes";
import { fetchPage } from "../crawl/fetcher";
import { generateSpec, type CrawlSpec } from "../crawl/extract";
import { mapItem, type ItemRow } from "../desk/desk";
import { deskSql } from "../desk/desk.sql";
import { collectSource } from "../crawl/collector";
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
async function findSubscribedSource(
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
  const [tags, count, fields] = await Promise.all([
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
  ]);
  return {
    id: sub.id,
    sourceId,
    displayName: sub.display_name,
    url: String(source.url),
    categoryId: sub.category_id,
    tagIds: tags.rows.map((t) => t.tag_id),
    fetchStrategy: source.fetch_strategy as Subscription["fetchStrategy"],
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

// 수동 스펙 재생성: 현재 페이지를 다시 받아 DOM 휴리스틱으로 새 버전을 만든다.
// 기존 스펙에 저장된 힌트(hint)가 있으면 같은 영역을 다시 찾도록 재사용한다.
export async function rebuildSpec(
  userId: string,
  sourceId: string,
): Promise<{ version: number }> {
  const { source } = await findSubscribedSource(userId, sourceId);
  const db = getDb();

  const { rows: activeSpecRows } = await db.query<{ spec: unknown }>(
    sourcesSql.latestActiveSpec,
    [sourceId],
  );
  // pg는 jsonb를 이미 파싱된 객체로 반환하므로 문자열일 때만 JSON.parse한다.
  const storedSpec = activeSpecRows[0]
    ? (typeof activeSpecRows[0].spec === "string"
        ? JSON.parse(activeSpecRows[0].spec)
        : activeSpecRows[0].spec) as CrawlSpec
    : null;
  const storedHint = storedSpec?.hint;

  const page = await fetchPage(String(source.url));
  const generated = generateSpec(page.body, page.finalUrl, storedHint);
  if (!generated) {
    throw new AppError(
      errorCodes.EXTRACTION_FAILED,
      "페이지에서 목록 패턴을 추출할 수 없습니다.",
      422,
    );
  }

  const { rows: v } = await db.query<{ v: number }>(
    `select coalesce(max(version), 0) as v from myportal.crawl_specs where source_id = $1`,
    [sourceId],
  );
  const next = Number(v[0]?.v ?? 0) + 1;
  await db.transaction(async (tx) => {
    await tx.query(sourcesSql.deactivateSpecs, [sourceId]);
    await tx.query(sourcesSql.insertSpec, [
      sourceId,
      next,
      JSON.stringify(generated.spec),
      "manual",
    ]);
    await tx.query(
      `update myportal.sources set fetch_strategy = 'html', status = 'ok' where id = $1`,
      [sourceId],
    );
  });
  return { version: next };
}
