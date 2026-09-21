import type { DatabaseClient } from "@ttoltori/database";
import { getDb } from "../../config/db";

export interface KeywordRuleRow {
  id: string;
  user_id: string;
  name: string;
  keywords: string[];
  exclude: string[];
  scope: "all" | "category" | "tag";
  scope_id: string | null;
  action: "emphasize" | "alert" | "mute";
}

// 규칙 우선순위: mute > alert > emphasize (요건정의서 §6 키워드 규칙).
// mute가 이겨야 조용히 해야 할 항목이 강조로 뜨지 않는다.
const ACTION_PRIORITY: Record<string, number> = {
  mute: 3,
  alert: 2,
  emphasize: 1,
};

export function ruleAppliesToText(rule: KeywordRuleRow, text: string): boolean {
  const haystack = text.toLowerCase();
  for (const ex of rule.exclude) {
    if (ex && haystack.includes(ex.toLowerCase())) return false;
  }
  for (const kw of rule.keywords) {
    if (kw && haystack.includes(kw.toLowerCase())) return true;
  }
  return false;
}

// 사용자의 규칙이 해당 구독에 적용되는지 범위(scope)로 판정한다.
async function ruleAppliesToSubscription(
  db: DatabaseClient,
  rule: KeywordRuleRow,
  subscription: { category_id: string | null; subscription_id: string },
): Promise<boolean> {
  switch (rule.scope) {
    case "all":
      return true;
    case "category":
      return rule.scope_id !== null && rule.scope_id === subscription.category_id;
    case "tag": {
      if (!rule.scope_id) return false;
      const { rows } = await db.query<{ x: number }>(
        `select 1 as x from myportal.subscription_tags
         where subscription_id = $1 and tag_id = $2`,
        [subscription.subscription_id, rule.scope_id],
      );
      return rows.length > 0;
    }
  }
}

// 새 항목마다 구독 사용자 전체의 규칙을 평가해 최우선 매치 1건을 기록한다.
export async function matchNewItemsForSubscribers(
  sourceId: string,
  itemIds: string[],
): Promise<void> {
  if (itemIds.length === 0) return;
  const db = getDb();

  const { rows: subs } = await db.query<{
    subscription_id: string;
    user_id: string;
    category_id: string | null;
  }>(
    `select id as subscription_id, user_id, category_id
     from myportal.subscriptions
     where source_id = $1 and paused = false`,
    [sourceId],
  );
  if (subs.length === 0) return;

  const { rows: items } = await db.query<{
    id: string;
    title: string;
    excerpt: string | null;
    attrs: Record<string, unknown> | string;
  }>(
    `select id, title, excerpt, attrs from myportal.items where id = any($1::uuid[])`,
    [itemIds],
  );

  const userIds = [...new Set(subs.map((s) => s.user_id))];
  const { rows: ruleRows } = await db.query<{
    id: string;
    user_id: string;
    name: string;
    keywords: string;
    exclude: string;
    scope: KeywordRuleRow["scope"];
    scope_id: string | null;
    action: KeywordRuleRow["action"];
  }>(
    `select id, user_id, name, keywords, exclude, scope, scope_id, action
     from myportal.keyword_rules
     where user_id = any($1::uuid[])`,
    [userIds],
  );

  const rulesByUser = new Map<string, KeywordRuleRow[]>();
  for (const r of ruleRows) {
    const parsed: KeywordRuleRow = {
      ...r,
      keywords: parseJsonArray(r.keywords),
      exclude: parseJsonArray(r.exclude),
    };
    const list = rulesByUser.get(r.user_id) ?? [];
    list.push(parsed);
    rulesByUser.set(r.user_id, list);
  }

  for (const sub of subs) {
    const rules = rulesByUser.get(sub.user_id) ?? [];
    if (rules.length === 0) continue;

    for (const item of items) {
      const attrs =
        typeof item.attrs === "string"
          ? (JSON.parse(item.attrs) as Record<string, unknown>)
          : item.attrs;
      const text = [item.title, item.excerpt ?? "", JSON.stringify(attrs)]
        .join(" ");

      let best: KeywordRuleRow | null = null;
      for (const rule of rules) {
        if (!(await ruleAppliesToSubscription(db, rule, sub))) continue;
        if (!ruleAppliesToText(rule, text)) continue;
        if (
          !best ||
          ACTION_PRIORITY[rule.action] > ACTION_PRIORITY[best.action]
        ) {
          best = rule;
        }
      }

      if (best) {
        await db.query(
          `insert into myportal.item_rule_matches (user_id, item_id, rule_id, action)
           values ($1, $2, $3, $4)
           on conflict (user_id, item_id) do update
             set rule_id = excluded.rule_id, action = excluded.action`,
          [sub.user_id, item.id, best.id, best.action],
        );
      }
    }
  }
}

function parseJsonArray(v: unknown): string[] {
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
