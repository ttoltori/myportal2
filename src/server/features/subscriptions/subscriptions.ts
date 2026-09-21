import type { Subscription } from "@myportal/api-contracts";
import type { DatabaseClient } from "@ttoltori/database";
import { getDb } from "../../config/db";
import { AppError, errorCodes } from "../../errors/error-codes";

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

const sql = {
  list: `
    select s.id, s.source_id, s.display_name, s.category_id, s.paused,
           src.url, src.fetch_strategy, src.status, src.last_success_at,
           src.interval_minutes
    from myportal.subscriptions s
    join myportal.sources src on src.id = s.source_id
    where s.user_id = $1
    order by s.display_name
  `,
  find: `
    select s.id, s.source_id, s.display_name, s.category_id, s.paused,
           src.url, src.fetch_strategy, src.status, src.last_success_at,
           src.interval_minutes
    from myportal.subscriptions s
    join myportal.sources src on src.id = s.source_id
    where s.id = $1 and s.user_id = $2
  `,
  update: `
    update myportal.subscriptions
    set display_name = coalesce($3, display_name),
        category_id = case when $4 then $5 else category_id end,
        paused = coalesce($6, paused)
    where id = $1 and user_id = $2
    returning id
  `,
  delete: `
    delete from myportal.subscriptions where id = $1 and user_id = $2
  `,
  tagsFor: `
    select tag_id from myportal.subscription_tags where subscription_id = $1
  `,
  replaceTagsDelete: `
    delete from myportal.subscription_tags where subscription_id = $1
  `,
  insertTagLink: `
    insert into myportal.subscription_tags (subscription_id, tag_id)
    values ($1, $2) on conflict do nothing
  `,
  tagOwned: `
    select id from myportal.tags where id = $1 and user_id = $2
  `,
  categoryOwned: `
    select id from myportal.categories where id = $1 and user_id = $2
  `,
  new7d: `
    select count(*)::int as c from myportal.items
    where source_id = $1 and is_baseline = false
      and collected_at > now() - interval '7 days'
  `,
  fieldsFor: `
    select key, label, type, role, sort_order, visible
    from myportal.source_fields where source_id = $1 order by sort_order
  `,
};

async function mapSub(db: DatabaseClient, r: SubRow): Promise<Subscription> {
  const [tags, count, fields] = await Promise.all([
    db.query<{ tag_id: string }>(sql.tagsFor, [r.id]),
    db.query<{ c: number }>(sql.new7d, [r.source_id]),
    db.query<{
      key: string; label: string; type: string; role: string;
      sort_order: number; visible: boolean;
    }>(sql.fieldsFor, [r.source_id]),
  ]);
  return {
    id: r.id,
    sourceId: r.source_id,
    displayName: r.display_name,
    url: r.url,
    categoryId: r.category_id,
    tagIds: tags.rows.map((t) => t.tag_id),
    fetchStrategy: r.fetch_strategy as Subscription["fetchStrategy"],
    status: r.status as Subscription["status"],
    lastSuccessAt: r.last_success_at
      ? new Date(r.last_success_at).toISOString()
      : null,
    new7d: count.rows[0]?.c ?? 0,
    intervalMinutes: r.interval_minutes,
    paused: r.paused,
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

export async function listSubscriptions(userId: string): Promise<Subscription[]> {
  const db = getDb();
  const { rows } = await db.query<SubRow>(sql.list, [userId]);
  return Promise.all(rows.map((r) => mapSub(db, r)));
}

export async function updateSubscription(
  userId: string,
  id: string,
  patch: {
    displayName?: string;
    categoryId?: string | null;
    paused?: boolean;
    tagIds?: string[];
  },
): Promise<Subscription> {
  const db = getDb();
  const { rows: existing } = await db.query<SubRow>(sql.find, [id, userId]);
  if (!existing[0]) {
    throw new AppError(errorCodes.SOURCE_NOT_FOUND, "구독을 찾을 수 없습니다.", 404);
  }

  if (patch.categoryId) {
    const { rows: cat } = await db.query<{ id: string }>(sql.categoryOwned, [
      patch.categoryId,
      userId,
    ]);
    if (!cat[0]) {
      throw new AppError(errorCodes.CATEGORY_NOT_FOUND, "카테고리를 찾을 수 없습니다.", 404);
    }
  }
  if (patch.tagIds) {
    for (const tagId of patch.tagIds) {
      const { rows: t } = await db.query<{ id: string }>(sql.tagOwned, [tagId, userId]);
      if (!t[0]) {
        throw new AppError(errorCodes.NOT_FOUND, "태그를 찾을 수 없습니다.", 404);
      }
    }
  }

  await db.transaction(async (tx) => {
    await tx.query(sql.update, [
      id,
      userId,
      patch.displayName ?? null,
      patch.categoryId !== undefined,
      patch.categoryId ?? null,
      patch.paused ?? null,
    ]);
    if (patch.tagIds) {
      await tx.query(sql.replaceTagsDelete, [id]);
      for (const tagId of patch.tagIds) {
        await tx.query(sql.insertTagLink, [id, tagId]);
      }
    }
  });

  const { rows } = await db.query<SubRow>(sql.find, [id, userId]);
  return mapSub(db, rows[0]);
}

export async function deleteSubscription(
  userId: string,
  id: string,
): Promise<void> {
  const db = getDb();
  const res = await db.query(sql.delete, [id, userId]);
  if ((res.rowCount ?? 0) === 0) {
    throw new AppError(errorCodes.SOURCE_NOT_FOUND, "구독을 찾을 수 없습니다.", 404);
  }
}

export async function bulkSubscriptions(
  userId: string,
  input: {
    subscriptionIds: string[];
    action: "move" | "tag" | "pause" | "unsubscribe";
    categoryId?: string;
    tagName?: string;
  },
): Promise<{ updated: number }> {
  const db = getDb();

  if (input.action === "move") {
    if (!input.categoryId) {
      throw new AppError(errorCodes.VALIDATION_ERROR, "categoryId가 필요합니다.", 400);
    }
    const { rows: cat } = await db.query<{ id: string }>(sql.categoryOwned, [
      input.categoryId,
      userId,
    ]);
    if (!cat[0]) {
      throw new AppError(errorCodes.CATEGORY_NOT_FOUND, "카테고리를 찾을 수 없습니다.", 404);
    }
  }

  return db.transaction(async (tx) => {
    const { rows: owned } = await tx.query<{ id: string }>(
      `select id from myportal.subscriptions
       where user_id = $1 and id = any($2::uuid[])`,
      [userId, input.subscriptionIds],
    );
    const ids = owned.map((r) => r.id);
    if (ids.length === 0) return { updated: 0 };

    switch (input.action) {
      case "move":
        await tx.query(
          `update myportal.subscriptions set category_id = $3
           where user_id = $1 and id = any($2::uuid[])`,
          [userId, ids, input.categoryId],
        );
        break;
      case "tag": {
        if (!input.tagName?.trim()) {
          throw new AppError(errorCodes.VALIDATION_ERROR, "tagName이 필요합니다.", 400);
        }
        const { rows: tag } = await tx.query<{ id: string }>(
          `insert into myportal.tags (user_id, name) values ($1, $2)
           on conflict (user_id, name) do update set name = excluded.name
           returning id`,
          [userId, input.tagName.trim()],
        );
        for (const sid of ids) {
          await tx.query(sql.insertTagLink, [sid, tag[0].id]);
        }
        break;
      }
      case "pause":
        await tx.query(
          `update myportal.subscriptions set paused = true
           where user_id = $1 and id = any($2::uuid[])`,
          [userId, ids],
        );
        break;
      case "unsubscribe":
        await tx.query(
          `delete from myportal.subscriptions
           where user_id = $1 and id = any($2::uuid[])`,
          [userId, ids],
        );
        break;
    }
    return { updated: ids.length };
  });
}
