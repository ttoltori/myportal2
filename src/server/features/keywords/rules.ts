import type { KeywordRule } from "@myportal/api-contracts";
import { getDb } from "../../config/db";
import { AppError, errorCodes } from "../../errors/error-codes";
import { mapItem, type ItemRow } from "../desk/desk";
import { deskSql } from "../desk/desk.sql";

const sql = {
  list: `
    select id, name, keywords, exclude, scope, scope_id, action
    from myportal.keyword_rules where user_id = $1 order by created_at
  `,
  find: `
    select id, name, keywords, exclude, scope, scope_id, action
    from myportal.keyword_rules where id = $1 and user_id = $2
  `,
  insert: `
    insert into myportal.keyword_rules
      (user_id, name, keywords, exclude, scope, scope_id, action)
    values ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7)
    returning id, name, keywords, exclude, scope, scope_id, action
  `,
  update: `
    update myportal.keyword_rules
    set name = $3, keywords = $4::jsonb, exclude = $5::jsonb,
        scope = $6, scope_id = $7, action = $8, updated_at = now()
    where id = $1 and user_id = $2
    returning id, name, keywords, exclude, scope, scope_id, action
  `,
  delete: `
    delete from myportal.keyword_rules where id = $1 and user_id = $2
  `,
};

interface RuleRow {
  id: string; name: string; keywords: unknown; exclude: unknown;
  scope: KeywordRule["scope"]; scope_id: string | null;
  action: KeywordRule["action"];
}

function strArr(v: unknown): string[] {
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

function toRule(r: RuleRow): KeywordRule {
  return {
    id: r.id,
    name: r.name,
    keywords: strArr(r.keywords),
    exclude: strArr(r.exclude),
    scope: r.scope,
    scopeId: r.scope_id,
    action: r.action,
  };
}

async function assertScopeExists(
  userId: string,
  scope: string,
  scopeId: string | null,
): Promise<void> {
  const db = getDb();
  if (scope === "category" && scopeId) {
    const { rows } = await db.query<{ id: string }>(
      `select id from myportal.categories where id = $1 and user_id = $2`,
      [scopeId, userId],
    );
    if (!rows[0]) {
      throw new AppError(errorCodes.CATEGORY_NOT_FOUND, "카테고리를 찾을 수 없습니다.", 404);
    }
  }
  if (scope === "tag" && scopeId) {
    const { rows } = await db.query<{ id: string }>(
      `select id from myportal.tags where id = $1 and user_id = $2`,
      [scopeId, userId],
    );
    if (!rows[0]) {
      throw new AppError(errorCodes.NOT_FOUND, "태그를 찾을 수 없습니다.", 404);
    }
  }
}

export async function listRules(userId: string): Promise<KeywordRule[]> {
  const db = getDb();
  const { rows } = await db.query<RuleRow>(sql.list, [userId]);
  return rows.map(toRule);
}

export async function createRule(
  userId: string,
  input: Omit<KeywordRule, "id" | "scopeId"> & { scopeId: string | null },
): Promise<KeywordRule> {
  await assertScopeExists(userId, input.scope, input.scopeId);
  const db = getDb();
  const { rows } = await db.query<RuleRow>(sql.insert, [
    userId,
    input.name,
    JSON.stringify(input.keywords),
    JSON.stringify(input.exclude),
    input.scope,
    input.scope === "all" ? null : input.scopeId,
    input.action,
  ]);
  return toRule(rows[0]);
}

export async function updateRule(
  userId: string,
  id: string,
  input: Omit<KeywordRule, "id" | "scopeId"> & { scopeId: string | null },
): Promise<KeywordRule> {
  const db = getDb();
  const { rows: existing } = await db.query<RuleRow>(sql.find, [id, userId]);
  if (!existing[0]) {
    throw new AppError(errorCodes.NOT_FOUND, "키워드 규칙을 찾을 수 없습니다.", 404);
  }
  await assertScopeExists(userId, input.scope, input.scopeId);
  const { rows } = await db.query<RuleRow>(sql.update, [
    id,
    userId,
    input.name,
    JSON.stringify(input.keywords),
    JSON.stringify(input.exclude),
    input.scope,
    input.scope === "all" ? null : input.scopeId,
    input.action,
  ]);
  return toRule(rows[0]);
}

export async function deleteRule(userId: string, id: string): Promise<void> {
  const db = getDb();
  const res = await db.query(sql.delete, [id, userId]);
  if ((res.rowCount ?? 0) === 0) {
    throw new AppError(errorCodes.NOT_FOUND, "키워드 규칙을 찾을 수 없습니다.", 404);
  }
}

// 규칙 미리보기: 조건을 만족하는 현재 항목 수와 샘플을 반환한다.
export async function previewRule(
  userId: string,
  input: {
    keywords: string[];
    exclude: string[];
    scope: "all" | "category" | "tag";
    scopeId: string | null;
  },
): Promise<{ count: number; items: ReturnType<typeof mapItem>[] }> {
  const db = getDb();

  const scopeJoin =
    input.scope === "category"
      ? "and (s.category_id = $3 or s.category_id in (select id from myportal.categories where user_id = $1 and parent_id = $3))"
      : input.scope === "tag"
        ? "and exists (select 1 from myportal.subscription_tags st where st.subscription_id = s.id and st.tag_id = $3)"
        : "";

  const { rows } = await db.query<ItemRow>(
    `select i.id, i.source_id, i.title, i.url, i.published_at, i.collected_at,
            i.excerpt, i.attrs, i.is_baseline, i.cluster_id,
            coalesce(st.read, false) as read,
            coalesce(st.starred, false) as starred,
            rm.rule_id, rm.action as rule_action, kr.name as rule_name
     from myportal.items i
     join myportal.subscriptions s
       on s.source_id = i.source_id and s.user_id = $1 and s.paused = false
     left join myportal.item_states st
       on st.item_id = i.id and st.user_id = $1
     left join myportal.item_rule_matches rm
       on rm.item_id = i.id and rm.user_id = $1
     left join myportal.keyword_rules kr on kr.id = rm.rule_id
     where i.is_baseline = false ${scopeJoin}
     order by i.collected_at desc
     limit 400`,
    input.scope === "all" ? [userId] : [userId, input.scopeId],
  );

  const { rows: fieldRows } = await db.query<{ source_id: string; key: string }>(
    deskSql.deadlineFields,
  );
  const deadlineMap = new Map<string, string>();
  for (const f of fieldRows) deadlineMap.set(f.source_id, f.key);

  const matched = rows.filter((r) => {
    const attrs = typeof r.attrs === "string" ? r.attrs : JSON.stringify(r.attrs);
    const text = `${r.title} ${r.excerpt ?? ""} ${attrs}`.toLowerCase();
    for (const ex of input.exclude) {
      if (ex && text.includes(ex.toLowerCase())) return false;
    }
    return input.keywords.some((k) => k && text.includes(k.toLowerCase()));
  });

  return {
    count: matched.length,
    items: matched.slice(0, 20).map((r) => mapItem(r, deadlineMap)),
  };
}
