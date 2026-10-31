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
  readPage,
  readPageRepair,
  type LlmModelConfig,
  type PageReadResult,
} from "./llm-read";
import type { PageOutline } from "./page-outline";
import { synthesizeSpec } from "./selector-synthesis";
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
  synthesisFailed: `AI가 읽은 항목을 셀렉터로 옮길 수 없었습니다${FALLBACK_SUFFIX}`,
  verificationFailed: `추출 결과가 AI가 읽은 내용과 달랐습니다${FALLBACK_SUFFIX}`,
  retrying: "추출 결과가 AI가 읽은 내용과 달라 한 번 더 읽습니다",
  repairSkippedForTime: `분석 시간이 길어 재해석을 건너뛰었습니다${FALLBACK_SUFFIX}`,
  hintMissing: "힌트 문자열이 현재 페이지에 없습니다 — 목록 내용이 바뀐 것 같습니다",
  listNotFound: "반복 목록을 찾지 못함",
} as const;

// chatJson은 스키마 불일치 시 2회 시도하고 시도당 타임아웃이 40초라 호출 하나가 최대 80초다.
// 서버리스 실행 한도 안에서 보수 호출까지 끝내려면, 이미 이만큼 지났을 때 보수를 포기한다.
const REPAIR_DEADLINE_MS = 45_000;

// 보수 호출에 알려 줄 추출 제목 수. llm-read가 앞쪽 3건만 쓰므로 그만큼만 넘긴다.
const REPAIR_SAMPLE_TITLES = 3;

// 개요가 잘렸으면 모델이 "푸터까지 다 본 것"으로 오해하지 않게 알린다.
// readPage가 문자열 하나만 받으므로 개요 텍스트 끝에 붙이는 것이 유일한 전달 경로다.
const TRUNCATED_NOTICE = "※ 페이지가 길어 개요의 뒷부분이 잘렸습니다. 아래에 없는 내용은 판단하지 마십시오.";

// 폴백 휴리스틱이 목록으로 인정하는 최소 행 수.
const MIN_FALLBACK_ROWS = 3;

const RATE_PERCENT = 100;
const YIELD_DIGITS = 2;

const EMPTY_SUGGESTED: AnalysisOutcome["suggested"] = {
  displayName: "",
  categoryPath: [],
  tagNames: [],
};

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

type Attempt =
  | { status: "unsynthesizable" }
  | { status: "rejected"; spec: CrawlSpec; rows: ExtractedRow[]; score: VerifyScore }
  | { status: "accepted"; spec: CrawlSpec; rows: ExtractedRow[]; score: VerifyScore };

function fieldCount(spec: CrawlSpec): number {
  return Object.keys(spec.fields ?? {}).length;
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

  const first = verifySpec(html, pageUrl, synthesis.spec, read);
  if (!first.score.ok) {
    return { status: "rejected", spec: synthesis.spec, rows: first.rows, score: first.score };
  }

  const pruned = pruneFailedFields(synthesis.spec, first.score);
  // 필드가 빠졌으면 미리보기 행에서도 그 값이 사라져야 하므로 같은 스펙으로 다시 추출한다.
  if (fieldCount(pruned) === fieldCount(synthesis.spec)) {
    return { status: "accepted", spec: pruned, rows: first.rows, score: first.score };
  }
  const final = verifySpec(html, pageUrl, pruned, read);
  return { status: "accepted", spec: pruned, rows: final.rows, score: final.score };
}

function pushAttemptSteps(steps: AnalyzeStep[], attempt: Attempt, willRetry: boolean): void {
  if (attempt.status === "unsynthesizable") {
    steps.push(step(LABEL.synthesis, "warn", MSG.synthesisFailed));
  } else if (attempt.status === "accepted") {
    steps.push(
      step(
        LABEL.verification,
        "ok",
        `${metricsText(attempt.score)}, 필드 ${fieldCount(attempt.spec)}개 채택`,
      ),
    );
  } else {
    const message = willRetry ? MSG.retrying : MSG.verificationFailed;
    steps.push(step(LABEL.verification, "warn", `${message} (${metricsText(attempt.score)})`));
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
  startedAt: number,
  rejected: Extract<Attempt, { status: "rejected" }>,
): Promise<PageReadResult | null> {
  if (Date.now() - startedAt > REPAIR_DEADLINE_MS) {
    steps.push(step(LABEL.reread, "warn", MSG.repairSkippedForTime));
    return null;
  }
  const read = await callLlm(ctx, () =>
    readPageRepair({
      outlineText: outlineTextFor(args.outline),
      pageUrl: args.pageUrl,
      hint: args.hint,
      model: ctx.model,
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

async function runLlmPath(
  args: RunAnalysisArgs,
  steps: AnalyzeStep[],
  startedAt: number,
): Promise<LlmPathResult> {
  const ctx = await prepareLlm(args, steps);
  if (!ctx) return NO_LLM_RESULT;

  const first = await callLlm(ctx, () =>
    readPage({
      outlineText: outlineTextFor(args.outline),
      pageUrl: args.pageUrl,
      hint: args.hint,
      model: ctx.model,
    }),
  );
  if (!first) {
    steps.push(step(LABEL.read, "warn", MSG.callFailed));
    return NO_LLM_RESULT;
  }
  steps.push(step(LABEL.read, "ok", first.items.length === 0 ? MSG.noList : readDetail(first)));
  if (first.items.length === 0) return { read: first, accepted: null, judgedNoList: true };

  const attempt = synthesizeAndVerify(args, first);
  // 합성 자체가 안 된 경우에는 시도한 셀렉터가 없어 보수 호출로 알려 줄 것이 없다.
  const canRepair = attempt.status === "rejected" && args.allowRepair !== false;
  pushAttemptSteps(steps, attempt, canRepair);
  if (attempt.status === "accepted") {
    return { read: first, accepted: { spec: attempt.spec, rows: attempt.rows }, judgedNoList: false };
  }
  if (attempt.status !== "rejected" || !canRepair) {
    return { read: first, accepted: null, judgedNoList: false };
  }

  const second = await repairRead(args, ctx, steps, startedAt, attempt);
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

function runFallback(args: RunAnalysisArgs, steps: AnalyzeStep[]): FallbackResult | null {
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
  const { document } = parseHTML(html);
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
  if (!read) return EMPTY_SUGGESTED;
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
