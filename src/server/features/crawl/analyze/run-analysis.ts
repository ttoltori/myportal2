import type { AnalyzeStep, PageKind, ParentCandidate } from "@myportal/api-contracts";
import { parseHTML } from "linkedom";
import { env, hasLlm } from "../../../config/env";
import {
  generateSpec,
  parseJsonLdList,
  type CrawlSpec,
  type ExtractedRow,
} from "../extract";
import { LlmError, type ChatJsonResult } from "../llm/llm-client";
import { checkLlmQuota, recordLlmCall, type LlmPurpose } from "../llm/usage";
import { absolutize } from "../url";
import {
  hintMatchesOutline,
  READ_TIMEOUT_MS,
  readPage,
  readPageRepair,
  type LlmModelConfig,
  type PageReadResult,
} from "./llm-read";
import type { PageOutline } from "./page-outline";
import { synthesizeSpec, type SynthesisResult } from "./selector-synthesis";
import { pruneFailedFields, verifySpec, type VerifyScore } from "./verify";

// 렌더링된 페이지 하나를 해석해 추출 스펙을 만든다: LLM 해석 → 셀렉터 합성 → 검증 → (보수) → 폴백.
// 설계서 §3, §7. LLM이 어떤 이유로 실패해도 예외를 던지지 않는다 —
// 모든 실패는 warn 단계로 남기고 휴리스틱 경로로 내려간다.

export interface AnalysisOutcome {
  spec: CrawlSpec | null;
  rows: ExtractedRow[];
  strategy: "rss" | "structured" | "html";
  feedUrl: string | null;
  fieldSource: "llm" | "heuristic" | null;
  listCandidates: ParentCandidate[];
  suggested: { displayName: string; categoryPath: string[]; tagNames: string[] };
  pageKind: PageKind;
  // LLM이 읽은 페이지 제목. <title>이 비어 있을 때만 호출자가 쓴다.
  pageTitle: string | null;
  steps: AnalyzeStep[];
}

export interface RunAnalysisArgs {
  // 렌더링된(렌더링에 실패했다면 정적) 문서. outline은 이 문서에서 만든 것이어야 한다.
  html: string;
  pageUrl: string;
  outline: PageOutline;
  hint?: string;
  // 힌트를 사용자가 입력한 시각. 저장된 힌트를 재사용하는 호출자가 원래 시각을 넘긴다.
  // 생략하면 지금 입력된 힌트로 본다.
  hintSetAt?: string;
  userId: string | null;
  sourceId: string | null;
  purpose: LlmPurpose;
  // 검증 미달 시 보수 호출을 허용하는가. 자가복구는 힌트 없이·힌트로 두 번 호출하므로
  // 1회차에서 false를 넘겨 분석 1건당 LLM 호출 상한을 지킨다.
  allowRepair?: boolean;
  // 분석 시작 시각(ms). 보수 호출 여부를 정하는 시간 예산의 기준이다.
  // 생략하면 이 함수 진입 시각이다.
  startedAt?: number;
}

// ── 문구와 상수 ──

const LABEL = {
  read: "AI 페이지 해석",
  reread: "AI 재해석",
  synthesis: "셀렉터 합성",
  verification: "셀렉터 합성·검증",
  hint: "힌트 확인",
  heuristic: "HTML 목록 패턴 추출",
  jsonLd: "구조화 데이터(JSON-LD) 감지",
} as const;

const FALLBACK_SUFFIX = " — 패턴 추정으로 진행";

// 사용자에게 보이는 문구는 전부 여기 고정값이다.
// LlmError.message는 프로바이더 원문을 담을 수 있어(CLAUDE.md §15) 단계에 절대 넣지 않고 서버 로그에만 남긴다.
const MSG = {
  notConfigured: `AI 분석이 설정되지 않았습니다${FALLBACK_SUFFIX}`,
  quotaExceeded: `일별 AI 분석 한도를 초과했습니다${FALLBACK_SUFFIX}`,
  callFailed: `AI 분석 호출에 실패했습니다${FALLBACK_SUFFIX}`,
  noList: "AI가 이 페이지에서 목록을 찾지 못했습니다 (상세 페이지로 판단)",
  contradictory: `AI가 목록 페이지라고 답했지만 항목을 하나도 짚지 못했습니다${FALLBACK_SUFFIX}`,
  synthesisFailed: `AI가 읽은 항목을 셀렉터로 옮길 수 없었습니다${FALLBACK_SUFFIX}`,
  verificationFailed: `추출 결과가 AI가 읽은 내용과 달랐습니다${FALLBACK_SUFFIX}`,
  retrying: "추출 결과가 AI가 읽은 내용과 달라 한 번 더 읽습니다",
  readSkippedForTime: `분석 시간이 길어 AI 해석을 건너뛰었습니다${FALLBACK_SUFFIX}`,
  repairSkippedForTime: `분석 시간이 길어 재해석을 건너뛰었습니다${FALLBACK_SUFFIX}`,
  emptyPage: `페이지에서 읽을 내용을 찾지 못했습니다${FALLBACK_SUFFIX}`,
  hintMissing: "힌트 문자열이 현재 페이지에 없습니다 — 목록 내용이 바뀐 것 같습니다",
  listNotFound: "반복 목록을 찾지 못함",
  fallbackCrashed: "패턴 추정 중 오류가 발생했습니다 — 목록을 찾지 못함",
} as const;

// ── 시간 예산 ──
// 한 요청은 플랫폼의 maxDuration(src/app/api/[...path]/route.ts) 안에 끝나야 한다. 넘기면
// 플랫폼이 중간에 끊어 폴백도 못 타고 응답 자체가 없는데, 이것이 가장 나쁜 실패다.
// LLM 앞단의 최악 소요는 고정할 수 없다: fetchPage 15초 + 브라우저 기동 + 렌더링
// (render.ts: goto 30 + networkidle 6 + SPA 대기 1 + networkidle 6 + 안정화 8 ≈ 51초) 이고,
// 거기에 chatJson의 최대 2시도 × 시도 timeout이 더해진다. 최악을 다 더하면
// 15 + 51 + 80 = 146초로 120초를 넘는다. 그렇다고 마감을 고정값으로 조이면 느리게 렌더링되는
// 사이트(이번 작업의 주 대상인 JS 목록 사이트)가 LLM 분석을 아예 못 받는다.
// 그래서 호출 직전에 남은 시간으로 시도 timeout을 정한다 (첫 호출과 보수 호출 모두):
//   남은 예산    = PLATFORM_MAX_DURATION_MS − (지금 − 분석 시작) − TAIL_MARGIN_MS
//   시도 timeout = clamp(남은 예산 ÷ LLM_MAX_ATTEMPTS, MIN_ATTEMPT_TIMEOUT_MS, READ_TIMEOUT_MS)
//   시도 timeout이 하한 미만이면 호출하지 않고 폴백한다.
// 호출의 최악 소요(시도 timeout × 2회)가 남은 예산 이하라서 합계가 구조적으로 한도 안에 들어간다.
// 숫자를 손으로 맞추는 것이 아니다. 꼬리 여유는 호출 뒤의 합성·검증·프로파일 계산과 응답 몫이다.
// PLATFORM_MAX_DURATION_MS는 라우트의 maxDuration과 같은 값이어야 한다. 라우트는 어댑터 계층이라
// import하지 않고 옮겨 적었으므로 한쪽을 바꾸면 다른 쪽도 바꾼다. LLM_MAX_ATTEMPTS는 chatJson의
// 스키마 시도 횟수(MAX_SCHEMA_ATTEMPTS)와 같아야 한다.
const PLATFORM_MAX_DURATION_MS = 120_000;
const LLM_MAX_ATTEMPTS = 2;
const TAIL_MARGIN_MS = 10_000;
// 하한 근거: 보통 크기의 응답(실제로는 1~3k토큰 JSON)을 받아볼 수 있는 최소선이다.
// 최대 응답(8k토큰)을 보장하는 선이 아니다 — 8k토큰을 15초에 쓰려면 약 530 tok/s가 필요해
// 현실적이지 않다. 이보다 짧게 잡으면 첫 시도가 거의 확실히 timeout되어 프로바이더의 토큰
// 과금과 15초만 낭비하고 폴백으로 가므로, 그럴 바에는 호출하지 않는 편이 낫다.
// (timeout 호출은 ok=false로 기록되고 일별 한도 집계(usage.sql.ts)는 ok=true만 세므로 한도는 소비하지 않는다.)
const MIN_ATTEMPT_TIMEOUT_MS = 15_000;

// 지금 호출한다면 시도당 timeout(ms). 예산이 부족해 호출하면 안 되면 null.
function attemptTimeoutMs(startedAt: number): number | null {
  const remaining = PLATFORM_MAX_DURATION_MS - (Date.now() - startedAt) - TAIL_MARGIN_MS;
  const perAttempt = Math.floor(remaining / LLM_MAX_ATTEMPTS);
  if (perAttempt < MIN_ATTEMPT_TIMEOUT_MS) return null;
  return Math.min(perAttempt, READ_TIMEOUT_MS);
}

// 보수 호출에 알려 줄 추출 제목 수. llm-read가 앞쪽 3건만 쓰므로 그만큼만 넘긴다.
const REPAIR_SAMPLE_TITLES = 3;

// 개요가 잘렸으면 모델이 "푸터까지 다 본 것"으로 오해하지 않게 알린다.
// readPage가 문자열 하나만 받으므로 개요 텍스트 끝에 붙이는 것이 유일한 전달 경로다.
const TRUNCATED_NOTICE = "※ 페이지가 길어 개요의 뒷부분이 잘렸습니다. 아래에 없는 내용은 판단하지 마십시오.";

// 단계 detail에 싣는 문구. 개요가 잘렸다는 사실은 왜 목록을 일부만 찾았는지(혹은 못 찾았는지) 설명한다.
const OUTLINE_TRUNCATED_NOTE = "페이지가 길어 개요 일부가 잘림";

// 합성 로그에 싣는 제외 사유의 최대 개수. 항목마다 사유가 반복될 수 있어 로그가 길어지는 것을 막는다.
const MAX_LOGGED_DROPS = 10;

// 폴백 휴리스틱이 목록으로 인정하는 최소 행 수.
const MIN_FALLBACK_ROWS = 3;

const RATE_PERCENT = 100;
const YIELD_DIGITS = 2;

// 모듈 공유 객체를 응답에 실으면 하류에서 배열에 push했을 때 이후 모든 응답이 오염되므로 매번 새로 만든다.
function emptySuggested(): AnalysisOutcome["suggested"] {
  return { displayName: "", categoryPath: [], tagNames: [] };
}

// ── 단계 도우미 ──

function step(label: string, status: AnalyzeStep["status"], detail: string | null): AnalyzeStep {
  return { label, status, detail };
}

function percent(rate: number): number {
  return Math.round(rate * RATE_PERCENT);
}

function metricsText(score: VerifyScore): string {
  return `항목 ${score.itemCount}건, 제목 일치율 ${percent(score.titleMatchRate)}%, 수율 ${score.rowYield.toFixed(YIELD_DIGITS)}`;
}

function countReportedFields(read: PageReadResult): number {
  return new Set(read.items.flatMap((item) => item.fields.map((f) => f.key))).size;
}

function readDetail(read: PageReadResult): string {
  return `목록 ${read.items.length}건, 필드 ${countReportedFields(read)}개`;
}

// 개요가 잘렸으면 해석 단계 detail에 그 사실을 덧붙인다.
function withTruncationNote(detail: string, outline: PageOutline): string {
  return outline.truncated ? `${detail} (${OUTLINE_TRUNCATED_NOTE})` : detail;
}

// ── LLM 호출 ──

interface LlmContext {
  model: LlmModelConfig;
  userId: string | null;
  sourceId: string | null;
  purpose: LlmPurpose;
}

function modelConfig(): LlmModelConfig {
  return { baseUrl: env.llmApiBase, apiKey: env.llmApiKey, model: env.llmModel };
}

// 이력 기록 실패가 분석 결과를 바꾸면 안 된다.
async function recordSafely(
  ctx: LlmContext,
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
      userId: ctx.userId,
      sourceId: ctx.sourceId,
      purpose: ctx.purpose,
      model: ctx.model.model,
      ...outcome,
    });
  } catch (err) {
    console.error("[analyze] LLM 호출 이력 기록 실패:", err);
  }
}

// 호출 하나를 실행하고 성공·실패와 무관하게 이력을 남긴다. 실패는 null로 돌려준다 —
// 어떤 예외도 호출자에게 전파하지 않는다.
async function callLlm(
  ctx: LlmContext,
  call: () => Promise<ChatJsonResult<PageReadResult>>,
): Promise<PageReadResult | null> {
  const started = Date.now();
  let result: ChatJsonResult<PageReadResult>;
  try {
    result = await call();
  } catch (err) {
    console.error("[analyze] LLM 호출 실패:", err);
    await recordSafely(ctx, {
      promptTokens: null,
      completionTokens: null,
      durationMs: Date.now() - started,
      ok: false,
      errorCode: err instanceof LlmError ? err.kind : "unknown",
    });
    return null;
  }
  await recordSafely(ctx, {
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    durationMs: result.durationMs,
    ok: true,
    errorCode: null,
  });
  return result.data;
}

async function withinQuota(userId: string | null): Promise<boolean> {
  try {
    return await checkLlmQuota(userId);
  } catch (err) {
    // 판정할 수 없으면 호출을 열지 않는다 — usage.ts의 fail-closed와 같은 이유다.
    console.error("[analyze] LLM 한도 확인 실패:", err);
    return false;
  }
}

function outlineTextFor(outline: PageOutline): string {
  return outline.truncated ? `${outline.text}\n\n${TRUNCATED_NOTICE}` : outline.text;
}

// ── 합성·검증 ──

// droppedCount: 합성이 버린 필드·항목 수. 단계 detail에 보여 줄 수치다(설계서 §5-4).
type Attempt =
  | { status: "unsynthesizable" }
  | { status: "rejected"; spec: CrawlSpec; rows: ExtractedRow[]; score: VerifyScore; droppedCount: number }
  | { status: "accepted"; spec: CrawlSpec; rows: ExtractedRow[]; score: VerifyScore; droppedCount: number };

function fieldCount(spec: CrawlSpec): number {
  return Object.keys(spec.fields ?? {}).length;
}

// remapped 비율은 설계서 §12가 모델 분리 여부를 판단하는 근거로 지정한 지표다. 값 매칭 폴백은
// 조용히 동작하므로 남기지 않으면 관측할 방법이 없다. 사유 문자열은 번호와 고정 문구뿐이지만,
// 페이지에서 온 값이 섞이지 않도록 key와 사유만 싣는다(값은 싣지 않는다).
function logSynthesis(synthesis: SynthesisResult): void {
  const { remapped, dropped } = synthesis;
  const shown = dropped
    .slice(0, MAX_LOGGED_DROPS)
    .map((d) => `${d.key}: ${d.reason}`)
    .join("; ");
  const more = dropped.length > MAX_LOGGED_DROPS ? ` 외 ${dropped.length - MAX_LOGGED_DROPS}건` : "";
  console.log(
    `[analyze] 셀렉터 합성: remapped=${remapped}, dropped=${dropped.length}${shown ? ` (${shown}${more})` : ""}`,
  );
}

function synthesizeAndVerify(args: RunAnalysisArgs, read: PageReadResult): Attempt {
  const { html, pageUrl, outline } = args;
  let synthesis: ReturnType<typeof synthesizeSpec>;
  try {
    synthesis = synthesizeSpec(outline, read, pageUrl);
  } catch (err) {
    // 합성은 순수 함수라 던지지 않는 것이 원칙이지만, 던져도 분석 전체가 죽으면 안 된다.
    console.error("[analyze] 셀렉터 합성 중 예외:", err);
    synthesis = null;
  }
  if (!synthesis) return { status: "unsynthesizable" };
  logSynthesis(synthesis);
  const droppedCount = synthesis.dropped.length;

  const first = verifySpec(html, pageUrl, synthesis.spec, read);
  if (!first.score.ok) {
    return { status: "rejected", spec: synthesis.spec, rows: first.rows, score: first.score, droppedCount };
  }

  const pruned = pruneFailedFields(synthesis.spec, first.score);
  // 필드가 빠졌으면 미리보기 행에서도 그 값이 사라져야 하므로 같은 스펙으로 다시 추출한다.
  if (fieldCount(pruned) === fieldCount(synthesis.spec)) {
    return { status: "accepted", spec: pruned, rows: first.rows, score: first.score, droppedCount };
  }
  const final = verifySpec(html, pageUrl, pruned, read);
  return { status: "accepted", spec: pruned, rows: final.rows, score: final.score, droppedCount };
}

function droppedNote(droppedCount: number): string {
  return droppedCount > 0 ? `, 합성 중 제외 ${droppedCount}건` : "";
}

function pushAttemptSteps(steps: AnalyzeStep[], attempt: Attempt, willRetry: boolean): void {
  if (attempt.status === "unsynthesizable") {
    steps.push(step(LABEL.synthesis, "warn", MSG.synthesisFailed));
  } else if (attempt.status === "accepted") {
    steps.push(
      step(
        LABEL.verification,
        "ok",
        `${metricsText(attempt.score)}, 필드 ${fieldCount(attempt.spec)}개 채택${droppedNote(attempt.droppedCount)}`,
      ),
    );
  } else {
    const message = willRetry ? MSG.retrying : MSG.verificationFailed;
    steps.push(
      step(
        LABEL.verification,
        "warn",
        `${message} (${metricsText(attempt.score)}${droppedNote(attempt.droppedCount)})`,
      ),
    );
  }
}

// ── LLM 경로 ──

interface LlmPathResult {
  read: PageReadResult | null;
  accepted: { spec: CrawlSpec; rows: ExtractedRow[] } | null;
  // LLM이 읽고도 목록이 없다고 판단했다. 이때는 휴리스틱으로 되묻지 않는다 —
  // 모델이 상세 페이지라고 본 곳에서 패턴 추정이 메뉴를 목록으로 집는 것을 막기 위해서다.
  judgedNoList: boolean;
}

const NO_LLM_RESULT: LlmPathResult = { read: null, accepted: null, judgedNoList: false };

// LLM을 호출할 수 있는지 확인한다. 못 하면 사유를 단계로 남기고 null을 돌려준다.
async function prepareLlm(args: RunAnalysisArgs, steps: AnalyzeStep[]): Promise<LlmContext | null> {
  if (!hasLlm()) {
    steps.push(step(LABEL.read, "warn", MSG.notConfigured));
    return null;
  }
  if (!(await withinQuota(args.userId))) {
    steps.push(step(LABEL.read, "warn", MSG.quotaExceeded));
    return null;
  }
  return { model: modelConfig(), userId: args.userId, sourceId: args.sourceId, purpose: args.purpose };
}

// 첫 시도가 검증에서 걸렸을 때 한 번 더 읽는다. 보수를 하지 않았거나 실패했으면 null.
async function repairRead(
  args: RunAnalysisArgs,
  ctx: LlmContext,
  steps: AnalyzeStep[],
  rejected: Extract<Attempt, { status: "rejected" }>,
  timeoutMs: number,
): Promise<PageReadResult | null> {
  const read = await callLlm(ctx, () =>
    readPageRepair({
      outlineText: outlineTextFor(args.outline),
      pageUrl: args.pageUrl,
      hint: args.hint,
      model: ctx.model,
      timeoutMs,
      attempted: {
        itemSelector: rejected.spec.itemSelector ?? "",
        extractedTitles: rejected.rows.slice(0, REPAIR_SAMPLE_TITLES).map((r) => r.title),
      },
    }),
  );
  if (!read) {
    steps.push(step(LABEL.reread, "warn", MSG.callFailed));
    return null;
  }
  steps.push(step(LABEL.reread, "ok", readDetail(read)));
  return read;
}

// items가 빈 응답을 해석한다. 상세·불명이라고 답했다면 목록이 없다는 판단을 믿는다.
// 반대로 "list"라면서 항목을 하나도 못 짚은 응답은 스스로 모순이라 믿을 근거가 없으므로
// 폴백이 목록을 찾게 한다 (judgedNoList=false).
function interpretEmptyRead(
  read: PageReadResult,
  outline: PageOutline,
  steps: AnalyzeStep[],
): LlmPathResult {
  if (read.pageKind === "list") {
    steps.push(step(LABEL.read, "warn", withTruncationNote(MSG.contradictory, outline)));
    return { read, accepted: null, judgedNoList: false };
  }
  steps.push(step(LABEL.read, "ok", withTruncationNote(MSG.noList, outline)));
  return { read, accepted: null, judgedNoList: true };
}

async function runLlmPath(
  args: RunAnalysisArgs,
  steps: AnalyzeStep[],
  startedAt: number,
): Promise<LlmPathResult> {
  // 개요가 비면(빈 문서, 차단 페이지) 모델에게 보여 줄 것이 없다. 호출하면 한도만 소비하고,
  // 모델이 "목록 없음"으로 답해 사용자가 원인을 상세 페이지로 오해하게 된다.
  // 본문은 비었어도 링크 구역만 있는 개요는 비었다고 보지 않는다: 목록으로 가는 링크를
  // listCandidates로 짚는 일은 LLM만 할 수 있고 폴백 휴리스틱은 못 한다.
  if (args.outline.text.trim() === "") {
    steps.push(step(LABEL.read, "warn", MSG.emptyPage));
    return NO_LLM_RESULT;
  }
  const ctx = await prepareLlm(args, steps);
  if (!ctx) return NO_LLM_RESULT;

  // 설정·한도 사유를 먼저 가린 뒤에 시간을 본다. 안 그러면 미설정인데 "시간이 길어"라고 말하게 된다.
  const firstTimeout = attemptTimeoutMs(startedAt);
  if (firstTimeout === null) {
    steps.push(step(LABEL.read, "warn", MSG.readSkippedForTime));
    return NO_LLM_RESULT;
  }
  const first = await callLlm(ctx, () =>
    readPage({
      outlineText: outlineTextFor(args.outline),
      pageUrl: args.pageUrl,
      hint: args.hint,
      model: ctx.model,
      timeoutMs: firstTimeout,
    }),
  );
  if (!first) {
    steps.push(step(LABEL.read, "warn", MSG.callFailed));
    return NO_LLM_RESULT;
  }
  if (first.items.length === 0) return interpretEmptyRead(first, args.outline, steps);
  steps.push(step(LABEL.read, "ok", withTruncationNote(readDetail(first), args.outline)));

  const attempt = synthesizeAndVerify(args, first);
  // 합성 자체가 안 된 경우에는 시도한 셀렉터가 없어 보수 호출로 알려 줄 것이 없다.
  const repairWanted = attempt.status === "rejected" && args.allowRepair !== false;
  // 보수는 첫 호출이 끝난 지금 시점의 남은 예산으로 다시 계산한다. 판정은 첫 단계 문구를 정하기 전에
  // 끝낸다. 그렇지 않으면 "한 번 더 읽습니다"를 남긴 직후 "건너뛰었습니다"가 이어져 로그가 모순된다.
  const repairTimeout = repairWanted ? attemptTimeoutMs(startedAt) : null;
  pushAttemptSteps(steps, attempt, repairTimeout !== null);
  if (repairWanted && repairTimeout === null) {
    steps.push(step(LABEL.reread, "warn", MSG.repairSkippedForTime));
  }
  if (attempt.status === "accepted") {
    return { read: first, accepted: { spec: attempt.spec, rows: attempt.rows }, judgedNoList: false };
  }
  if (attempt.status !== "rejected" || repairTimeout === null) {
    return { read: first, accepted: null, judgedNoList: false };
  }

  const second = await repairRead(args, ctx, steps, attempt, repairTimeout);
  if (!second) return { read: first, accepted: null, judgedNoList: false };

  const retry = synthesizeAndVerify(args, second);
  pushAttemptSteps(steps, retry, false);
  return {
    read: second,
    accepted: retry.status === "accepted" ? { spec: retry.spec, rows: retry.rows } : null,
    judgedNoList: false,
  };
}

// ── 폴백 경로 (설계서 §7) ──

interface FallbackResult {
  spec: CrawlSpec;
  rows: ExtractedRow[];
  strategy: "structured" | "html";
}

// 폴백은 분석이 가진 마지막 수단이다. 파서가 예기치 못한 입력에 던지면 요청이 500이 되어
// 사용자가 지금까지 쌓인 단계 로그조차 받지 못한다. 그래서 실패를 값(null + warn 단계)으로 환원한다.
function runFallback(args: RunAnalysisArgs, steps: AnalyzeStep[]): FallbackResult | null {
  try {
    return runFallbackUnguarded(args, steps);
  } catch (err) {
    console.error("[analyze] 폴백 추출 중 예외:", err);
    steps.push(step(LABEL.heuristic, "warn", MSG.fallbackCrashed));
    return null;
  }
}

function runFallbackUnguarded(args: RunAnalysisArgs, steps: AnalyzeStep[]): FallbackResult | null {
  const generated = generateSpec(args.html, args.pageUrl, args.hint);
  if (generated && generated.rows.length >= MIN_FALLBACK_ROWS) {
    steps.push(step(LABEL.heuristic, "ok", `${generated.rows.length}개 항목`));
    return { spec: generated.spec, rows: generated.rows, strategy: "html" };
  }
  const jsonLd = parseJsonLdList(args.html, args.pageUrl);
  if (jsonLd && jsonLd.length >= MIN_FALLBACK_ROWS) {
    steps.push(step(LABEL.jsonLd, "ok", `${jsonLd.length}개 항목`));
    return { spec: { strategy: "structured" }, rows: jsonLd, strategy: "structured" };
  }
  steps.push(step(LABEL.heuristic, "fail", MSG.listNotFound));
  return null;
}

// ── 힌트 ──

// 입력 시점을 함께 남겨야 "저장된 힌트가 낡았다"를 화면에서 알릴 수 있다 (설계서 §6-2).
function withHint(spec: CrawlSpec, hint: string | undefined, setAt: string): CrawlSpec {
  if (!hint || spec.strategy !== "html") return spec;
  return { ...spec, hint, hintSetAt: setAt };
}

// ── 부모 목록 후보 ──

// LLM은 링크 구역에 없는 URL도 지어낼 수 있다. 페이지에 실제로 있는 앵커만 통과시킨다.
function verifiedListCandidates(
  html: string,
  pageUrl: string,
  proposed: PageReadResult["listCandidates"],
): ParentCandidate[] {
  if (!proposed || proposed.length === 0) return [];
  let document: Document;
  try {
    ({ document } = parseHTML(html));
  } catch (err) {
    // 후보는 부가 정보다. 검증할 수 없으면 신뢰할 수 없는 후보를 내보내느니 비운다.
    console.error("[analyze] 부모 목록 후보 검증용 파싱 실패:", err);
    return [];
  }
  const pageAnchors = new Set<string>();
  for (const a of document.querySelectorAll("a[href]")) {
    const abs = absolutize(a.getAttribute("href") ?? "", pageUrl);
    if (abs) pageAnchors.add(abs);
  }
  const accepted = new Map<string, ParentCandidate>();
  for (const candidate of proposed) {
    const abs = absolutize(candidate.url, pageUrl);
    if (!abs || abs === pageUrl || !pageAnchors.has(abs) || accepted.has(abs)) continue;
    accepted.set(abs, { label: candidate.label.trim() || abs, url: abs });
  }
  return [...accepted.values()];
}

function cleanSuggested(read: PageReadResult | null): AnalysisOutcome["suggested"] {
  if (!read) return emptySuggested();
  const { displayName, categoryPath, tagNames } = read.suggested;
  const clean = (list: string[]) => list.map((s) => s.trim()).filter((s) => s !== "");
  return { displayName: displayName.trim(), categoryPath: clean(categoryPath), tagNames: clean(tagNames) };
}

// ── 진입점 ──

export async function runAnalysis(args: RunAnalysisArgs): Promise<AnalysisOutcome> {
  const startedAt = args.startedAt ?? Date.now();
  const hintSetAt = args.hintSetAt ?? new Date().toISOString();
  const steps: AnalyzeStep[] = [];

  // 힌트는 단서일 뿐 목록 탐지를 결정하지 않는다. 그래서 개요에 없어도 분석은 계속한다.
  if (args.hint && !hintMatchesOutline(args.outline.text, args.hint)) {
    steps.push(step(LABEL.hint, "warn", MSG.hintMissing));
  }

  const llm = await runLlmPath(args, steps, startedAt);

  let result: { spec: CrawlSpec; rows: ExtractedRow[]; strategy: "structured" | "html" } | null = null;
  let fieldSource: AnalysisOutcome["fieldSource"] = null;
  if (llm.accepted) {
    result = { ...llm.accepted, strategy: "html" };
    fieldSource = "llm";
  } else if (!llm.judgedNoList) {
    result = runFallback(args, steps);
    fieldSource = result ? "heuristic" : null;
  }

  const spec = result ? withHint(result.spec, args.hint, hintSetAt) : null;
  const listCandidates = spec ? [] : verifiedListCandidates(args.html, args.pageUrl, llm.read?.listCandidates);
  const pageKind: PageKind = spec ? "list" : llm.read?.pageKind === "detail" ? "detail" : "unknown";

  return {
    spec,
    rows: result?.rows ?? [],
    strategy: result?.strategy ?? "html",
    feedUrl: null,
    fieldSource,
    listCandidates,
    suggested: cleanSuggested(llm.read),
    pageKind,
    pageTitle: llm.read?.pageTitle.trim() || null,
    steps,
  };
}
