import type { Tag } from "@myportal/api-contracts";
import { getDb } from "../../config/db";
import { AppError, errorCodes } from "../../errors/error-codes";

const sql = {
  list: `
    select id, name from myportal.tags where user_id = $1 order by name
  `,
  insert: `
    insert into myportal.tags (user_id, name) values ($1, $2)
    on conflict (user_id, name) do update set name = excluded.name
    returning id, name
  `,
  update: `
    update myportal.tags set name = $3
    where id = $1 and user_id = $2
    returning id, name
  `,
  delete: `
    delete from myportal.tags where id = $1 and user_id = $2
  `,
};

export async function listTags(userId: string): Promise<Tag[]> {
  const db = getDb();
  const { rows } = await db.query<Tag>(sql.list, [userId]);
  return rows;
}

export async function createTag(userId: string, name: string): Promise<Tag> {
  const db = getDb();
  const { rows } = await db.query<Tag>(sql.insert, [userId, name.trim()]);
  return rows[0];
}

export async function updateTag(
  userId: string,
  id: string,
  name: string,
): Promise<Tag> {
  const db = getDb();
  const { rows } = await db.query<Tag>(sql.update, [id, userId, name.trim()]);
  if (!rows[0]) {
    throw new AppError(errorCodes.NOT_FOUND, "태그를 찾을 수 없습니다.", 404);
  }
  return rows[0];
}

export async function deleteTag(userId: string, id: string): Promise<void> {
  const db = getDb();
  const res = await db.query(sql.delete, [id, userId]);
  if ((res.rowCount ?? 0) === 0) {
    throw new AppError(errorCodes.NOT_FOUND, "태그를 찾을 수 없습니다.", 404);
  }
}
