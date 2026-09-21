import { getDb } from "../../config/db";
import { AppError, errorCodes } from "../../errors/error-codes";
import { mapItem, type ItemRow } from "../desk/desk";
import { deskSql } from "../desk/desk.sql";

// 범위(scope) 타입 → 해당 사용자에게 보이는 item_id 목록으로 해석한다.
const SCOPE_SQL: Record<string, string> = {
  all: `
    select i.id from myportal.items i
    join myportal.subscriptions s on s.source_id = i.source_id
    where s.user_id = $1 and i.is_baseline = false
  `,
  special: `
    select i.id from myportal.items i
    join myportal.subscriptions s on s.source_id = i.source_id
    where s.user_id = $1 and i.is_baseline = false
      and i.collected_at > coalesce(
        (select last_visit_at from myportal.user_settings where user_id = $1),
        '1970-01-01'::timestamptz)
  `,
  category: `
    select i.id from myportal.items i
    join myportal.subscriptions s on s.source_id = i.source_id
    where s.user_id = $1 and i.is_baseline = false
      and (s.category_id = $2 or s.category_id in (
        select c.id from myportal.categories c
        where c.user_id = $1 and (c.id = $2 or c.parent_id = $2
          or c.parent_id in (select c2.id from myportal.categories c2
                             where c2.user_id = $1 and c2.parent_id = $2))
      ))
  `,
  tag: `
    select i.id from myportal.items i
    join myportal.subscriptions s on s.source_id = i.source_id
    join myportal.subscription_tags st on st.subscription_id = s.id
    where s.user_id = $1 and st.tag_id = $2 and i.is_baseline = false
  `,
  source: `
    select i.id from myportal.items i
    join myportal.subscriptions s on s.source_id = i.source_id
    where s.user_id = $1 and s.id = $2 and i.is_baseline = false
  `,
};

function itemVisibleSql(userCheck = true): string {
  return `
    select i.id from myportal.items i
    join myportal.subscriptions s on s.source_id = i.source_id
    where i.id = $2 ${userCheck ? "and s.user_id = $1" : ""}
  `;
}

export async function updateItemState(
  userId: string,
  itemId: string,
  patch: { read?: boolean; starred?: boolean },
): Promise<{ items: ReturnType<typeof mapItem>[] }> {
  const db = getDb();

  const { rows: visible } = await db.query<{ id: string }>(
    itemVisibleSql(),
    [userId, itemId],
  );
  if (!visible[0]) {
    throw new AppError(errorCodes.NOT_FOUND, "항목을 찾을 수 없습니다.", 404);
  }

  await db.query(
    `insert into myportal.item_states (user_id, item_id, read, read_at, starred)
     values ($1, $2,
             coalesce($3, false),
             case when $3 = true then now() else null end,
             coalesce($4, false))
     on conflict (user_id, item_id) do update
       set read = coalesce($3, item_states.read),
           read_at = case
             when $3 = true then now()
             when $3 = false then null
             else item_states.read_at end,
           starred = coalesce($4, item_states.starred)`,
    [userId, itemId, patch.read ?? null, patch.starred ?? null],
  );

  const deadlineMap = await deadlineMapFor();
  const { rows } = await db.query<ItemRow>(
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
     where i.id = $2`,
    [userId, itemId],
  );
  return { items: rows.map((r) => mapItem(r, deadlineMap)) };
}

async function deadlineMapFor() {
  const db = getDb();
  const { rows } = await db.query<{ source_id: string; key: string }>(
    deskSql.deadlineFields,
  );
  const map = new Map<string, string>();
  for (const r of rows) map.set(r.source_id, r.key);
  return map;
}

export async function markScopeRead(
  userId: string,
  scope: { type: string; id: string | null },
): Promise<{ updatedIds: string[] }> {
  const db = getDb();
  const sql = SCOPE_SQL[scope.type];
  if (!sql) {
    throw new AppError(errorCodes.VALIDATION_ERROR, "유효하지 않은 범위입니다.", 400);
  }

  const params: unknown[] = scope.type === "all" || scope.type === "special"
    ? [userId]
    : [userId, scope.id];
  const { rows: itemRows } = await db.query<{ id: string }>(sql, params);
  const ids = itemRows.map((r) => r.id);
  if (ids.length === 0) return { updatedIds: [] };

  await db.query(
    `insert into myportal.item_states (user_id, item_id, read, read_at)
     select $1, unnest($2::uuid[]), true, now()
     on conflict (user_id, item_id) do update
       set read = true, read_at = now()
     where item_states.read = false`,
    [userId, ids],
  );
  return { updatedIds: ids };
}

export async function restoreItemStates(
  userId: string,
  itemIds: string[],
  read: boolean,
): Promise<{ updated: number }> {
  const db = getDb();
  const result = await db.query(
    `insert into myportal.item_states (user_id, item_id, read, read_at)
     select $1, i.id, $3, case when $3 then now() else null end
     from myportal.items i
     join myportal.subscriptions s on s.source_id = i.source_id
     where i.id = any($2::uuid[]) and s.user_id = $1
     on conflict (user_id, item_id) do update
       set read = $3, read_at = case when $3 then now() else null end`,
    [userId, itemIds, read],
  );
  return { updated: result.rowCount ?? 0 };
}

export async function searchItems(
  userId: string,
  q: string,
): Promise<{ items: ReturnType<typeof mapItem>[] }> {
  const db = getDb();
  const deadlineMap = await deadlineMapFor();
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
     where i.is_baseline = false
       and (i.title ilike '%' || $2 || '%' or i.excerpt ilike '%' || $2 || '%')
     order by i.collected_at desc
     limit 50`,
    [userId, q],
  );
  return { items: rows.map((r) => mapItem(r, deadlineMap)) };
}
