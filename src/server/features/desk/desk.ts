import type {
  Category,
  DeskPayload,
  Item,
  KeywordRule,
  RuleAction,
  Subscription,
  Tag,
} from "@myportal/api-contracts";
import { getDb } from "../../config/db";
import { deskSql } from "./desk.sql";
import { parseDate } from "../crawl/extract";

const DESK_ITEM_LIMIT = 200;

export interface ItemRow {
  id: string;
  source_id: string;
  title: string;
  url: string | null;
  published_at: string | null;
  collected_at: string;
  excerpt: string | null;
  attrs: Record<string, unknown> | string;
  is_baseline: boolean;
  cluster_id: string | null;
  read: boolean;
  starred: boolean;
  rule_id: string | null;
  rule_action: string | null;
  rule_name: string | null;
}

function toIso(v: string | null): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function parseAttrs(v: ItemRow["attrs"]): Record<string, unknown> {
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return p && typeof p === "object" ? p : {};
    } catch {
      return {};
    }
  }
  return v ?? {};
}

export function mapItem(
  row: ItemRow,
  deadlineKeyBySource: Map<string, string>,
): Item {
  const attrs = parseAttrs(row.attrs);
  let deadlineAt: string | null = null;
  const deadlineKey = deadlineKeyBySource.get(row.source_id);
  if (deadlineKey && attrs[deadlineKey] !== undefined) {
    const raw = attrs[deadlineKey];
    // date_range 필드는 {start,end} 객체로 저장된다 — 마감은 end 기준.
    const candidate =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? String((raw as Record<string, unknown>).end ?? "")
        : String(raw);
    deadlineAt = parseDate(candidate);
  }
  return {
    id: row.id,
    sourceId: row.source_id,
    title: row.title,
    url: row.url,
    publishedAt: toIso(row.published_at),
    collectedAt: toIso(row.collected_at) ?? new Date().toISOString(),
    excerpt: row.excerpt,
    attrs,
    read: row.read,
    starred: row.starred,
    isBaseline: row.is_baseline,
    clusterId: row.cluster_id,
    ruleMatch: row.rule_id
      ? {
          ruleId: row.rule_id,
          ruleName: row.rule_name ?? "",
          action: (row.rule_action ?? "emphasize") as RuleAction,
        }
      : null,
    deadlineAt,
  };
}

async function deadlineKeyMap(): Promise<Map<string, string>> {
  const db = getDb();
  const { rows } = await db.query<{ source_id: string; key: string }>(
    deskSql.deadlineFields,
  );
  const map = new Map<string, string>();
  for (const r of rows) map.set(r.source_id, r.key);
  return map;
}

export async function getDeskPayload(userId: string): Promise<DeskPayload> {
  const db = getDb();

  const [
    catRes,
    tagRes,
    subRes,
    subTagRes,
    newCountRes,
    ruleRes,
    itemRes,
    clusterRes,
    settingsRes,
    lastCollectRes,
    warnRes,
    emailRes,
    deadlineMap,
    fieldRes,
  ] = await Promise.all([
    db.query<{ id: string; name: string; parent_id: string | null; sort_order: number }>(
      deskSql.categories, [userId]),
    db.query<{ id: string; name: string }>(deskSql.tags, [userId]),
    db.query<{
      id: string; source_id: string; display_name: string;
      category_id: string | null; paused: boolean; url: string;
      fetch_strategy: string; status: string;
      last_success_at: string | null; interval_minutes: number;
    }>(deskSql.subscriptions, [userId]),
    db.query<{ subscription_id: string; tag_id: string }>(deskSql.subscriptionTags, [userId]),
    db.query<{ source_id: string; c: number }>(deskSql.newCounts7d, [userId]),
    db.query<{
      id: string; name: string; keywords: unknown; exclude: unknown;
      scope: KeywordRule["scope"]; scope_id: string | null;
      action: KeywordRule["action"];
    }>(deskSql.keywordRules, [userId]),
    db.query<ItemRow>(deskSql.items, [userId, DESK_ITEM_LIMIT]),
    db.query<{ id: string; representative_item_id: string }>(deskSql.clusters, [userId]),
    db.query<{ last_visit_at: string | null; last_seen_at: string | null }>(
      deskSql.settings, [userId]),
    db.query<{ last_run: string | null }>(deskSql.lastCollect, [userId]),
    db.query<{ c: number }>(deskSql.warnCount, [userId]),
    db.query<{ email: string }>(deskSql.userEmail, [userId]),
    deadlineKeyMap(),
    db.query<{
      source_id: string; key: string; label: string; type: string;
      role: string; sort_order: number; visible: boolean;
    }>(
      `select sf.source_id, sf.key, sf.label, sf.type, sf.role, sf.sort_order, sf.visible
       from myportal.source_fields sf
       join myportal.subscriptions s on s.source_id = sf.source_id
       where s.user_id = $1
       order by sf.source_id, sf.sort_order`,
      [userId]),
  ]);

  const tagsBySub = new Map<string, string[]>();
  for (const r of subTagRes.rows) {
    const list = tagsBySub.get(r.subscription_id) ?? [];
    list.push(r.tag_id);
    tagsBySub.set(r.subscription_id, list);
  }
  const newCountBySource = new Map(newCountRes.rows.map((r) => [r.source_id, r.c]));
  const fieldsBySource = new Map<string, Subscription["fields"]>();
  for (const f of fieldRes.rows) {
    const list = fieldsBySource.get(f.source_id) ?? [];
    list.push({
      key: f.key,
      label: f.label,
      type: f.type as Subscription["fields"][number]["type"],
      role: f.role as Subscription["fields"][number]["role"],
      visible: f.visible,
      sortOrder: f.sort_order,
    });
    fieldsBySource.set(f.source_id, list);
  }

  const subscriptions: Subscription[] = subRes.rows.map((s) => ({
    id: s.id,
    sourceId: s.source_id,
    displayName: s.display_name,
    url: s.url,
    categoryId: s.category_id,
    tagIds: tagsBySub.get(s.id) ?? [],
    fetchStrategy: s.fetch_strategy as Subscription["fetchStrategy"],
    status: s.status as Subscription["status"],
    lastSuccessAt: toIso(s.last_success_at),
    new7d: newCountBySource.get(s.source_id) ?? 0,
    intervalMinutes: s.interval_minutes,
    paused: s.paused,
    fields: fieldsBySource.get(s.source_id) ?? [],
  }));

  const keywordRules: KeywordRule[] = ruleRes.rows.map((r) => ({
    id: r.id,
    name: r.name,
    keywords: toStringArray(r.keywords),
    exclude: toStringArray(r.exclude),
    scope: r.scope,
    scopeId: r.scope_id,
    action: r.action,
  }));

  const items = itemRes.rows.map((r) => mapItem(r, deadlineMap));

  // 방문 시각 갱신: 데스크 로드가 '확인'으로 간주된다.
  await db.query(deskSql.touchSeen, [userId]);

  return {
    now: new Date().toISOString(),
    lastVisitAt: toIso(settingsRes.rows[0]?.last_visit_at ?? null),
    categories: catRes.rows.map(
      (c): Category => ({
        id: c.id,
        name: c.name,
        parentId: c.parent_id,
        sortOrder: c.sort_order,
      }),
    ),
    tags: tagRes.rows.map((t): Tag => ({ id: t.id, name: t.name })),
    subscriptions,
    keywordRules,
    items,
    clusters: clusterRes.rows.map((c) => ({
      id: c.id,
      representativeItemId: c.representative_item_id,
    })),
    meta: {
      lastCollectAt: toIso(lastCollectRes.rows[0]?.last_run ?? null),
      sourceCount: subscriptions.length,
      warnCount: warnRes.rows[0]?.c ?? 0,
      userEmail: emailRes.rows[0]?.email ?? "",
    },
  };
}

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

export async function heartbeat(userId: string): Promise<string | null> {
  const db = getDb();
  const { rows } = await db.query<{ last_visit_at: string }>(
    deskSql.heartbeat,
    [userId],
  );
  return toIso(rows[0]?.last_visit_at ?? null);
}
