import type { AnalyzeStep } from "@myportal/api-contracts";
import { env, hasLlm } from "../../../config/env";
import type { CrawlSpec, ExtractedRow } from "../extract";
import {
  inferFields,
  inferListAndFields,
  validateInferredFields,
  type InferredField,
  type LlmModelConfig,
  type ValidatedFields,
} from "./field-inference";
import { LlmError } from "./llm-client";
import {
  checkLlmQuota,
  recordLlmCall,
  type LlmPurpose,
} from "./usage";

const STEP_LABEL = "AI 필드 분석";

// 사용자에게 보이는 문구는 전부 여기 고정값이다.
// LlmError.message(프로바이더 원문 포함 가능)는 단계에 절대 넣지 않고 서버 로그에만 남긴다.
const MSG = {
  notConfigured: "AI 분석이 설정되지 않았습니다 — 건너뜀",
  unsupportedStrategy: "이 추출 방식은 AI 필드 분석 대상이 아닙니다 — 건너뜀",
  quotaExceeded: "일별 AI 분석 한도를 초과했습니다",
  timeout: "AI 분석 시간이 초과되었습니다",
  http: "AI 분석 호출에 실패했습니다",
  schema: "AI 응답을 해석할 수 없습니다",
  allRejected: "추론된 필드가 유효하지 않습니다",
} as const;

const LLM_ERROR_MESSAGES: Record<LlmError["kind"], string> = {
  timeout: MSG.timeout,
  http: MSG.http,
  schema: MSG.schema,
};

export interface EnrichResult {
  spec: CrawlSpec;
  rows: ExtractedRow[];
  fieldSource: "llm" | "heuristic";
  step: AnalyzeStep;
}

export interface EnrichBase {
  spec: CrawlSpec;
  rows: ExtractedRow[];
}

export interface EnrichArgs {
  html: string;
  pageUrl: string;
  base: EnrichBase | null;
  userId: string | null;
  sourceId: string | null;
  purpose: LlmPurpose;
}

interface InferenceOutcome {
  itemSelector: string;
  fields: InferredField[];
  promptTokens: number | null;
  completionTokens: number | null;
  durationMs: number;
}

function warnStep(detail: string): AnalyzeStep {
  return { label: STEP_LABEL, status: "warn", detail };
}

// base가 있으면 휴리스틱 결과를 그대로 돌려주고, 없으면(구제 실패) null이다.
function fallback(base: EnrichBase | null, detail: string): EnrichResult | null {
  if (!base) return null;
  return {
    spec: base.spec,
    rows: base.rows,
    fieldSource: "heuristic",
    step: warnStep(detail),
  };
}

function modelConfig(): LlmModelConfig {
  return {
    baseUrl: env.llmApiBase,
    apiKey: env.llmApiKey,
    model: env.llmModel,
  };
}

async function runInference(
  args: EnrichArgs,
  itemSelector: string | null,
  model: LlmModelConfig,
): Promise<InferenceOutcome> {
  if (itemSelector !== null) {
    const r = await inferFields(args.html, itemSelector, model);
    return { itemSelector, fields: r.data.fields, ...usageOf(r) };
  }
  const r = await inferListAndFields(args.html, model);
  return {
    itemSelector: r.data.itemSelector,
    fields: r.data.fields,
    ...usageOf(r),
  };
}

function usageOf(r: {
  promptTokens: number | null;
  completionTokens: number | null;
  durationMs: number;
}) {
  return {
    promptTokens: r.promptTokens,
    completionTokens: r.completionTokens,
    durationMs: r.durationMs,
  };
}

// 이력 기록 실패가 분석 결과를 바꾸면 안 된다.
async function safeRecord(
  args: EnrichArgs,
  model: string,
  outcome: {
    promptTokens: number | null;
    completionTokens: number | null;
    durationMs: number;
    ok: boolean;
    errorCode: string | null;
  },
): Promise<void> {
  try {
    await recordLlmCall({
      userId: args.userId,
      sourceId: args.sourceId,
      purpose: args.purpose,
      model,
      ...outcome,
    });
  } catch (err) {
    console.error("[llm-enrich] failed to record llm call:", err);
  }
}

function successResult(
  validated: ValidatedFields,
  mode: "enrich" | "rescue",
): EnrichResult {
  const detail =
    mode === "enrich"
      ? `필드 ${validated.accepted.length}개 추론`
      : `AI가 목록 패턴을 찾았습니다 (${validated.rows.length}개 항목)`;
  return {
    spec: validated.spec,
    rows: validated.rows,
    fieldSource: "llm",
    step: { label: STEP_LABEL, status: "ok", detail },
  };
}

/**
 * LLM 필드 추론의 유일한 진입점. 어떤 실패도 예외가 아니라 warn 단계로 환원한다.
 * base가 null이면 구제(rescue) 모드 — 구제도 실패하면 null을 반환한다.
 */
export async function enrichWithLlm(
  args: EnrichArgs,
): Promise<EnrichResult | null> {
  const { base } = args;
  try {
    if (!hasLlm()) return fallback(base, MSG.notConfigured);

    // RSS/구조화 데이터에는 셀렉터 개념이 없다.
    if (base && (base.spec.strategy !== "html" || !base.spec.itemSelector)) {
      return fallback(base, MSG.unsupportedStrategy);
    }

    if (!(await checkLlmQuota(args.userId))) {
      return fallback(base, MSG.quotaExceeded);
    }

    const model = modelConfig();
    let inferred: InferenceOutcome;
    try {
      inferred = await runInference(args, base?.spec.itemSelector ?? null, model);
    } catch (err) {
      return await handleInferenceError(args, model.model, err);
    }

    const mode = base ? "enrich" : "rescue";
    const baseSpec: CrawlSpec = base
      ? base.spec
      : { strategy: "html", itemSelector: inferred.itemSelector, fields: {} };
    const validated = validateInferredFields(
      args.html,
      args.pageUrl,
      baseSpec,
      inferred.fields,
      mode,
    );

    // 호출 자체는 성공했으므로(비용 발생) 검증 결과와 무관하게 ok로 남긴다.
    await safeRecord(args, model.model, {
      promptTokens: inferred.promptTokens,
      completionTokens: inferred.completionTokens,
      durationMs: inferred.durationMs,
      ok: true,
      errorCode: null,
    });

    if (!validated) return fallback(base, MSG.allRejected);
    return successResult(validated, mode);
  } catch (err) {
    console.error("[llm-enrich] unexpected failure, using heuristic result:", err);
    return fallback(base, MSG.http);
  }
}

async function handleInferenceError(
  args: EnrichArgs,
  model: string,
  err: unknown,
): Promise<EnrichResult | null> {
  console.error("[llm-enrich] inference failed:", err);
  const kind = err instanceof LlmError ? err.kind : null;
  await safeRecord(args, model, {
    promptTokens: null,
    completionTokens: null,
    durationMs: 0,
    ok: false,
    errorCode: kind ?? "unknown",
  });
  return fallback(args.base, kind ? LLM_ERROR_MESSAGES[kind] : MSG.http);
}
