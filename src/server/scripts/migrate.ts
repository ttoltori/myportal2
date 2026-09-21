import "./load-env"; // 반드시 첫 import — 환경변수를 먼저 로드한다.
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { createDb, closePool } from "@ttoltori/database";

// 적용된 마이그레이션은 myportal.schema_migrations에 기록해 중복 실행을 막는다.
// 적용한 파일은 수정하지 않고 변경이 필요하면 새 파일을 추가한다 (CLAUDE.md §19).
async function main() {
  const db = createDb();
  const migrationsDir = join(process.cwd(), "database", "migrations", "myportal");

  await db.query(`
    create schema if not exists myportal;
    create table if not exists myportal.schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    );
  `);

  const applied = await db.query<{ name: string }>(
    `select name from myportal.schema_migrations`,
  );
  const appliedSet = new Set(applied.rows.map((r) => r.name));

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (appliedSet.has(file)) {
      console.log(`Skipping (already applied): ${file}`);
      continue;
    }
    const sql = readFileSync(join(migrationsDir, file), "utf-8");
    console.log(`Running migration: ${file}`);
    await db.query(sql);
    await db.query(`insert into myportal.schema_migrations (name) values ($1)`, [
      file,
    ]);
    console.log(`  done`);
  }

  console.log("All migrations completed.");
  await closePool();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
