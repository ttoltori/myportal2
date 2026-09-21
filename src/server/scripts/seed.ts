import "./load-env"; // 반드시 첫 import — 환경변수를 먼저 로드한다.
import { createDb, closePool } from "@ttoltori/database";

// 개발용 사용자를 미리 만든다. 첫 매직링크 로그인 시에도 자동 생성되지만,
// 시드로 만들어 두면 샘플 카테고리/태그까지 한 번에 준비된다.
const email = process.argv[2] ?? process.env.SEED_EMAIL ?? "dev@myportal.local";

async function main() {
  const db = createDb();
  await db.transaction(async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `insert into myportal.users (email) values ($1)
       on conflict (email) do update set email = excluded.email
       returning id`,
      [email.toLowerCase()],
    );
    const userId = rows[0].id;
    await tx.query(
      `insert into myportal.user_settings (user_id) values ($1)
       on conflict (user_id) do nothing`,
      [userId],
    );
    await tx.query(
      `insert into myportal.categories (user_id, name, parent_id, sort_order)
       select $1, '미분류', null, 9999
       where not exists (
         select 1 from myportal.categories
         where user_id = $1 and name = '미분류' and parent_id is null
       )`,
      [userId],
    );
    console.log(`Seeded user ${email} (${userId})`);
  });
  await closePool();
}

main().catch(async (err) => {
  console.error("seed failed:", err);
  await closePool();
  process.exit(1);
});
