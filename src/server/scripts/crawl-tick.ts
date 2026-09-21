import "./load-env"; // 반드시 첫 import — 환경변수를 먼저 로드한다.
import { getDb } from "../config/db";
import { closePool } from "@ttoltori/database";
import { collectSource } from "../features/crawl/collector";
import { sourcesSql } from "../features/sources/sources.sql";

const BATCH = 20;
const WATCH_INTERVAL_MS = 60_000;

async function tick(): Promise<void> {
  const db = getDb();
  const { rows: due } = await db.query<{ id: string }>(
    sourcesSql.dueSources,
    [BATCH],
  );
  if (due.length === 0) {
    console.log(`[crawl-tick] ${new Date().toISOString()} no due sources`);
    return;
  }
  console.log(`[crawl-tick] ${new Date().toISOString()} ${due.length} due source(s)`);
  for (const s of due) {
    try {
      const r = await collectSource(s.id);
      console.log(
        `  ${s.id}: ${r.result} new=${r.newCount}${r.errorCode ? " err=" + r.errorCode : ""}`,
      );
    } catch (err) {
      console.log(`  ${s.id}: fatal ${err instanceof Error ? err.message : err}`);
    }
  }
}

async function main() {
  const watch = process.argv.includes("--watch");
  await tick();
  if (!watch) {
    await closePool();
    return;
  }
  console.log(`[crawl-tick] watching every ${WATCH_INTERVAL_MS / 1000}s (Ctrl+C to stop)`);
  setInterval(() => {
    tick().catch((err) => console.error("[crawl-tick] tick failed:", err));
  }, WATCH_INTERVAL_MS);
}

main().catch(async (err) => {
  console.error("crawl-tick failed:", err);
  await closePool();
  process.exit(1);
});
