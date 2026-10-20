// OpenAI 호환 chat/completions 전송 계층.
// 다른 서비스로 파일 이동만으로 추출할 수 있도록 zod 외에는 아무것도 import하지 않는다.
import type { ZodType } from "zod";

const DEFAULT_MAX_TOKENS = 2000;
const DEFAULT_TEMPERATURE = 0;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_SCHEMA_ATTEMPTS = 2;
const RETRY_SUFFIX = "코드 블록 없이 JSON 객체만 출력하십시오.";

// AppError가 아니다 — 호출자가 반드시 잡아 폴백해야 하는 내부 오류이며 API 응답으로 새면 안 된다.
export class LlmError extends Error {
  constructor(
    message: string,
    readonly kind: "http" | "timeout" | "schema",
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export interface ChatJsonOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

export interface ChatJsonResult<T> {
  data: T;
  promptTokens: number | null;
  completionTokens: number | null;
  durationMs: number;
}

interface RawCompletion {
  content: unknown;
  promptTokens: number | null;
  completionTokens: number | null;
}

function asTokenCount(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isAbort(e: unknown): boolean {
  return isRecord(e) && (e.name === "AbortError" || e.name === "TimeoutError");
}

async function requestCompletion(opts: ChatJsonOptions, userPrompt: string): Promise<RawCompletion> {
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model: opts.model,
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: userPrompt },
        ],
        temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
        max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (e) {
    if (isAbort(e)) throw new LlmError("LLM 요청 시간 초과", "timeout");
    throw new LlmError("LLM 요청 실패", "http");
  }

  // HTTP 오류는 프롬프트를 고쳐도 해결되지 않으므로 호출자가 재시도하지 않는다.
  if (!res.ok) throw new LlmError(`HTTP ${res.status}`, "http");

  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    if (isAbort(e)) throw new LlmError("LLM 요청 시간 초과", "timeout");
    throw new LlmError("LLM 응답 본문을 읽을 수 없음", "http");
  }

  const choices = isRecord(body) ? body.choices : undefined;
  const first = Array.isArray(choices) ? (choices[0] as unknown) : undefined;
  const message = isRecord(first) ? first.message : undefined;
  const usage = isRecord(body) && isRecord(body.usage) ? body.usage : undefined;

  return {
    content: isRecord(message) ? message.content : undefined,
    promptTokens: asTokenCount(usage?.prompt_tokens),
    completionTokens: asTokenCount(usage?.completion_tokens),
  };
}

type Parsed<T> = { ok: true; data: T } | { ok: false; reason: string };

// 실패 사유에는 응답 원문을 싣지 않는다 — 재시도 프롬프트와 오류 메시지로 새어 나가면 안 된다.
function parseAndValidate<T>(schema: ZodType<T>, content: unknown): Parsed<T> {
  if (typeof content !== "string" || content.trim() === "") {
    return { ok: false, reason: "응답이 비어 있음" };
  }
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return { ok: false, reason: "응답이 JSON이 아님" };
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) return { ok: true, data: parsed.data };
  const issues = parsed.error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  return { ok: false, reason: `스키마 불일치 (${issues})` };
}

export async function chatJson<T>(
  schema: ZodType<T>,
  opts: ChatJsonOptions,
): Promise<ChatJsonResult<T>> {
  const startedAt = Date.now();
  let userPrompt = opts.user;
  let lastReason = "";

  for (let attempt = 1; attempt <= MAX_SCHEMA_ATTEMPTS; attempt++) {
    const raw = await requestCompletion(opts, userPrompt);
    const parsed = parseAndValidate(schema, raw.content);
    if (parsed.ok) {
      return {
        data: parsed.data,
        promptTokens: raw.promptTokens,
        completionTokens: raw.completionTokens,
        durationMs: Date.now() - startedAt,
      };
    }
    lastReason = parsed.reason;
    userPrompt = `${opts.user}\n\n[이전 응답 오류] ${parsed.reason}\n${RETRY_SUFFIX}`;
  }

  throw new LlmError(`LLM 응답 검증 실패: ${lastReason}`, "schema");
}
