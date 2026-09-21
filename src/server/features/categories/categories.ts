import type { Category } from "@myportal/api-contracts";
import { getDb } from "../../config/db";
import { AppError, errorCodes } from "../../errors/error-codes";

const MAX_DEPTH = 3;

const sql = {
  list: `
    select id, name, parent_id, sort_order
    from myportal.categories where user_id = $1
    order by sort_order, name
  `,
  find: `
    select id, name, parent_id, sort_order
    from myportal.categories where id = $1 and user_id = $2
  `,
  insert: `
    insert into myportal.categories (user_id, name, parent_id, sort_order)
    values ($1, $2, $3,
      coalesce((select max(sort_order) + 1 from myportal.categories
                where user_id = $1 and parent_id is not distinct from $3), 0))
    returning id, name, parent_id, sort_order
  `,
  update: `
    update myportal.categories
    set name = coalesce($3, name),
        parent_id = case when $4 then $5 else parent_id end
    where id = $1 and user_id = $2
    returning id, name, parent_id, sort_order
  `,
  delete: `
    delete from myportal.categories where id = $1 and user_id = $2
  `,
  moveSubscriptions: `
    update myportal.subscriptions set category_id = $3
    where user_id = $1 and category_id = $2
  `,
  reparentChildren: `
    update myportal.categories set parent_id = $3
    where user_id = $1 and parent_id = $2
  `,
};

function toCategory(r: {
  id: string; name: string; parent_id: string | null; sort_order: number;
}): Category {
  return { id: r.id, name: r.name, parentId: r.parent_id, sortOrder: r.sort_order };
}

// 부모 체인 깊이: 최대 3단계 (요건정의서 §6 카테고리 트리).
async function depthOf(userId: string, parentId: string | null): Promise<number> {
  if (!parentId) return 0;
  const db = getDb();
  let depth = 0;
  let current: string | null = parentId;
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current)) return Number.MAX_SAFE_INTEGER; // cycle
    seen.add(current);
    const result = await db.query<{ parent_id: string | null }>(
      `select parent_id from myportal.categories where id = $1 and user_id = $2`,
      [current, userId],
    );
    const rows: { parent_id: string | null }[] = result.rows;
    if (!rows[0]) return Number.MAX_SAFE_INTEGER; // parent not owned
    current = rows[0].parent_id;
    depth++;
    if (depth > MAX_DEPTH) break;
  }
  return depth;
}

async function assertValidParent(
  userId: string,
  categoryId: string | null,
  parentId: string | null,
): Promise<void> {
  if (!parentId) return;
  if (categoryId && parentId === categoryId) {
    throw new AppError(errorCodes.CATEGORY_CYCLE, "자기 자신을 부모로 지정할 수 없습니다.", 400);
  }
  // 부모가 되려는 노드의 하위에 categoryId가 있으면 순환
  if (categoryId) {
    const db = getDb();
    let current: string | null = parentId;
    const seen = new Set<string>();
    while (current) {
      if (current === categoryId) {
        throw new AppError(errorCodes.CATEGORY_CYCLE, "하위 카테고리를 부모로 지정할 수 없습니다.", 400);
      }
      if (seen.has(current)) break;
      seen.add(current);
      const result = await db.query<{ parent_id: string | null }>(
        `select parent_id from myportal.categories where id = $1 and user_id = $2`,
        [current, userId],
      );
      const rows: { parent_id: string | null }[] = result.rows;
      current = rows[0]?.parent_id ?? null;
    }
  }
  const depth = (await depthOf(userId, parentId)) + 1;
  if (depth > MAX_DEPTH) {
    throw new AppError(
      errorCodes.CATEGORY_DEPTH_EXCEEDED,
      "카테고리는 최대 3단계까지 만들 수 있습니다.",
      400,
    );
  }
}

export async function listCategories(userId: string): Promise<Category[]> {
  const db = getDb();
  const { rows } = await db.query<{
    id: string; name: string; parent_id: string | null; sort_order: number;
  }>(sql.list, [userId]);
  return rows.map(toCategory);
}

export async function createCategory(
  userId: string,
  name: string,
  parentId: string | null,
): Promise<Category> {
  await assertValidParent(userId, null, parentId);
  const db = getDb();
  const { rows } = await db.query<{
    id: string; name: string; parent_id: string | null; sort_order: number;
  }>(sql.insert, [userId, name, parentId]);
  return toCategory(rows[0]);
}

export async function updateCategory(
  userId: string,
  id: string,
  patch: { name?: string; parentId?: string | null },
): Promise<Category> {
  const db = getDb();
  const { rows: existing } = await db.query<{ id: string }>(sql.find, [id, userId]);
  if (!existing[0]) {
    throw new AppError(errorCodes.CATEGORY_NOT_FOUND, "카테고리를 찾을 수 없습니다.", 404);
  }
  if (patch.parentId !== undefined) {
    await assertValidParent(userId, id, patch.parentId);
  }
  const parentChanged = patch.parentId !== undefined;
  const { rows } = await db.query<{
    id: string; name: string; parent_id: string | null; sort_order: number;
  }>(sql.update, [id, userId, patch.name ?? null, parentChanged, patch.parentId ?? null]);
  return toCategory(rows[0]);
}

export async function deleteCategory(userId: string, id: string): Promise<void> {
  const db = getDb();
  const { rows: existing } = await db.query<{ id: string }>(sql.find, [id, userId]);
  if (!existing[0]) {
    throw new AppError(errorCodes.CATEGORY_NOT_FOUND, "카테고리를 찾을 수 없습니다.", 404);
  }
  await db.transaction(async (tx) => {
    // 하위 카테고리는 삭제되는 카테고리의 부모로, 구독은 미분류로 이동
    await tx.query(
      `update myportal.categories set parent_id =
         (select parent_id from myportal.categories where id = $2)
       where user_id = $1 and parent_id = $2`,
      [userId, id],
    );
    await tx.query(sql.moveSubscriptions, [userId, id, null]);
    await tx.query(sql.delete, [id, userId]);
  });
}

export async function mergeCategory(
  userId: string,
  id: string,
  targetId: string,
): Promise<void> {
  const db = getDb();
  const { rows: src } = await db.query<{ id: string }>(sql.find, [id, userId]);
  const { rows: dst } = await db.query<{ id: string }>(sql.find, [targetId, userId]);
  if (!src[0] || !dst[0]) {
    throw new AppError(errorCodes.CATEGORY_NOT_FOUND, "카테고리를 찾을 수 없습니다.", 404);
  }
  await db.transaction(async (tx) => {
    await tx.query(sql.moveSubscriptions, [userId, id, targetId]);
    await tx.query(sql.reparentChildren, [userId, id, targetId]);
    await tx.query(sql.delete, [id, userId]);
  });
}
