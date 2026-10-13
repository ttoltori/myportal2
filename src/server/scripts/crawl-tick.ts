import "./load-env"; // 반드시 첫 import — 환경변수를 먼저 로드한다.
import { getDb } from "../config/db";
import { closePool } from "@ttoltori/database";
import { collectSource } from "../features/crawl/collector";
import { sourcesSql } from "../features/sources/sources.sql";

const BATCH = 20;
const WATCH_INTERVAL_MS = 60_000;

// force=true면 next_crawl_at 스케줄을 무시하고 구독된 소스를 모두 수집한다.
async function tick(force: boolean): Promise<void> {
  const db = getDb();
  const { rows: due } = await db.query<{ id: string }>(
    sourcesSql.dueSources,
    [BATCH, force],
  );
  if (due.length === 0) {
    // "왜 안 도는지" 바로 알 수 있도록 구독 소스 수와 다음 예정 시각을 보여준다.
    const { rows: info } = await db.query<{ n: number; next: string | null }>(
      `select count(*)::int as n, min(s.next_crawl_at) as next
       from myportal.sources s
       where s.kind = 'list' and s.status <> 'pause'
         and exists (select 1 from myportal.subscriptions sub
                     where sub.source_id = s.id and sub.paused = false)`,
    );
    const n = info[0]?.n ?? 0;
    const next = info[0]?.next;
    const hint = n === 0
      ? "구독된 수집 소스가 없습니다"
      : `구독 소스 ${n}개 — 다음 예정 ${new Date(String(next)).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })} KST. 즉시 수집하려면 --force`;
    console.log(`[crawl-tick] ${new Date().toISOString()} no due sources (${hint})`);
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
  const force = process.argv.includes("--force") || process.argv.includes("-f");
  await tick(force);
  if (!watch) {
    await closePool();
    return;
  }
  // 강제 수집은 첫 틱에만 적용하고 이후는 정상 스케줄을 따른다.
  console.log(`[crawl-tick] watching every ${WATCH_INTERVAL_MS / 1000}s (Ctrl+C to stop)`);
  setInterval(() => {
    tick(false).catch((err) => console.error("[crawl-tick] tick failed:", err));
  }, WATCH_INTERVAL_MS);
}

main().catch(async (err) => {
  console.error("crawl-tick failed:", err);
  await closePool();
  process.exit(1);
});
