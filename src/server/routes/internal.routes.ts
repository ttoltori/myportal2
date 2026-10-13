import { Hono } from "hono";
import type { Context, Next } from "hono";
import { timingSafeEqual, createHash } from "crypto";
import { env } from "../config/env";
import { getDb } from "../config/db";
import { AppError, errorCodes } from "../errors/error-codes";
import { success } from "../utils/response";
import { collectSource } from "../features/crawl/collector";
import { sendDigestNow } from "../features/digest/digest";
import { sourcesSql } from "../features/sources/sources.sql";

// 내부 작업 엔드포인트는 세션 대신 공유 시크릿으로 보호한다 (cron/워커 호출용).
// 허용 헤더: x-internal-secret 또는 Authorization: Bearer (Vercel cron).
function internalAuth() {
  return async (c: Context, next: Next) => {
    if (!env.internalApiSecret) {
      throw new AppError(errorCodes.FORBIDDEN, "내부 API가 설정되지 않았습니다.", 403);
    }
    const bearer = c.req.header("authorization")?.replace(/^bearer\s+/i, "");
    const provided = c.req.header("x-internal-secret") || bearer || "";
    const a = createHash("sha256").update(provided).digest();
    const b = createHash("sha256").update(env.internalApiSecret).digest();
    if (!timingSafeEqual(a, b)) {
      throw new AppError(errorCodes.UNAUTHORIZED, "인증 실패.", 401);
    }
    await next();
  };
}

const TICK_BATCH = 20;

async function crawlTick(c: Context) {
  const db = getDb();
  const { rows: due } = await db.query<{ id: string }>(
    sourcesSql.dueSources,
    [TICK_BATCH, false],
  );
  const results: { sourceId: string; newCount: number; result: string }[] = [];
  for (const s of due) {
    try {
      const r = await collectSource(s.id);
      results.push({ sourceId: s.id, newCount: r.newCount, result: r.result });
    } catch (err) {
      results.push({
        sourceId: s.id,
        newCount: 0,
        result: err instanceof AppError ? err.code : "error",
      });
    }
  }
  return success(c, { processed: results.length, results });
}

async function digestTick(c: Context) {
  const db = getDb();
  const { rows: users } = await db.query<{ user_id: string }>(
    `select user_id from myportal.user_settings
     where digest_enabled = true
       and (digest_sent_at is null or digest_sent_at < now() - interval '20 hours')
       and (
         (digest_frequency = 'daily'
           and digest_time <= to_char(now() at time zone timezone, 'HH24:MI'))
         or
         (digest_frequency = 'weekly'
           and digest_weekday = extract(dow from now() at time zone timezone)::int
           and digest_time <= to_char(now() at time zone timezone, 'HH24:MI'))
       )
     limit 50`,
  );
  let sent = 0;
  for (const u of users) {
    try {
      const r = await sendDigestNow(u.user_id);
      if (r.sent) sent++;
    } catch {
      // 개별 실패는 digest_runs에 기록됨 — 배치는 계속 진행
    }
  }
  return success(c, { due: users.length, sent });
}

// due 소스를 한 번에 최대 TICK_BATCH개 수집한다.
// 로컬에서는 scripts/crawl-tick.ts가, Vercel에서는 cron이 이 엔드포인트를 호출한다.
// Vercel cron은 GET으로 호출하므로 GET도 허용한다.
export const internalRoutes = new Hono()
  .use("/*", internalAuth())
  .post("/internal/crawl-tick", crawlTick)
  .get("/internal/crawl-tick", crawlTick)
  .post("/internal/digest-tick", digestTick)
  .get("/internal/digest-tick", digestTick);
