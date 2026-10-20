import { getDb } from "../../../config/db";
import { env } from "../../../config/env";
import { llmUsageSql } from "./usage.sql";

export type LlmPurpose =
  | "analyze-fields"
  | "analyze-rescue"
  | "rebuild"
  | "self-repair";

export interface LlmCallEntry {
  userId: string | null;
  sourceId: string | null;
  purpose: LlmPurpose;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  durationMs: number;
  ok: boolean;
  errorCode: string | null;
}

/**
 * 오늘 성공한 호출 수가 상한 미만이면 true.
 * userId가 null이면(자가복구 등 시스템 경로) 시스템 상한을 적용한다.
 * 판정 쿼리가 실패하면 false(fail-closed) — 판정 불가 상태에서 호출을 열면
 * 비용 폭주를 막겠다는 상한의 목적이 사라지기 때문이다.
 */
export async function checkLlmQuota(userId: string | null): Promise<boolean> {
  try {
    const db = getDb();
    const result =
      userId === null
        ? await db.query<{ count: string }>(llmUsageSql.countTodaySystem)
        : await db.query<{ count: string }>(llmUsageSql.countTodayByUser, [
            userId,
          ]);
    const used = Number(result.rows[0]?.count ?? 0);
    const limit =
      userId === null ? env.llmDailyLimitSystem : env.llmDailyLimit;
    return used < limit;
  } catch (err) {
    console.error("[llm-usage] quota check failed, blocking call:", err);
    return false;
  }
}

/** 호출 이력을 기록한다. 기록 실패가 분석을 깨뜨리면 안 되므로 오류는 삼킨다. */
export async function recordLlmCall(entry: LlmCallEntry): Promise<void> {
  try {
    await getDb().query(llmUsageSql.insertCall, [
      entry.userId,
      entry.sourceId,
      entry.purpose,
      entry.model,
      entry.promptTokens,
      entry.completionTokens,
      entry.durationMs,
      entry.ok,
      entry.errorCode,
    ]);
  } catch (err) {
    console.error("[llm-usage] failed to record llm call:", err);
  }
}
