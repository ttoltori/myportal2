import type { Browser, LaunchOptions, Page } from "playwright-core";
import { env } from "../../config/env";
import { AppError, errorCodes } from "../../errors/error-codes";
import { assertPublicUrl } from "./url";

const GOTO_TIMEOUT_MS = 30_000;
// SPA가 데이터를 비동기로 채우므로 로드 후 네트워크가 잠잠해질 때까지 짧게 더 기다린다.
const SETTLE_TIMEOUT_MS = 6_000;
// hash 라우팅 SPA는 초기 로드 후 라우터가 API를 호출하기까지 시간이 걸린다.
// 첫 networkidle이 SPA 초기화 전에 발생하는 것을 보완하기 위한 대기 시간.
const SPA_ROUTE_DELAY_MS = 1_000;
// networkidle 이후에도 DOM이 안정될 때까지 폴링한다.
const STABLE_POLLS = 3;
const POLL_INTERVAL_MS = 500;
const MAX_STABILIZE_MS = 8_000;
const MAX_HTML_BYTES = 6 * 1024 * 1024;
// headless UA로 요청하면 차단하는 사이트가 있어 실제 Chrome UA를 쓴다.
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// 호출자가 대기 전략을 바꿀 수 있게 하는 옵션. 위 상수들은 옵션이 없을 때의 기본값이다.
export interface RenderOptions {
  // 이 셀렉터가 나타나면 시간 기반 대기를 건너뛰고 즉시 완료로 본다.
  waitForSelector?: string;
  // 네트워크 유휴·DOM 안정화 대기의 상한(ms). 프로파일의 측정값 기반 값을 넘긴다.
  settleMs?: number;
  // 지연 로딩 목록: 끝까지 스크롤해 항목을 더 불러온다.
  scrollToBottom?: boolean;
}

export interface RenderTimings {
  // goto 직전부터 로딩 완료 판정까지의 경과 시간(ms). 스크롤 시간은 포함하지 않는다.
  readyMs: number;
  // 로딩 완료를 무엇으로 판정했는가. 프로파일 신뢰도 판단에 쓴다.
  //  - selector: waitForSelector가 잡혔다 (readyMs가 실제 완료 시각에 가장 가깝다)
  //  - stabilized: DOM이 STABLE_POLLS회 연속 변하지 않았다
  //  - networkidle: DOM은 끝내 안정되지 않았지만 네트워크는 유휴에 도달했다
  //  - timeout: goto 실패이거나 네트워크 유휴·DOM 안정 어느 쪽도 확인하지 못했다
  readyBy: "selector" | "networkidle" | "stabilized" | "timeout";
  // 스크롤로 문서 높이가 늘어났는가 (지연 로딩 목록 판정 근거)
  grewByScroll: boolean;
}

export interface RenderedPage {
  finalUrl: string;
  html: string;
  timings: RenderTimings;
}

// 무한 스크롤이 끝없이 이어지는 페이지에서 멈추기 위한 상한.
const MAX_SCROLLS = 5;

async function resolveLaunch(): Promise<LaunchOptions> {
  if (env.chromiumPath) {
    return { headless: true, executablePath: env.chromiumPath };
  }
  if (env.isProduction) {
    // Vercel 같은 서버리스 환경에서는 시스템 Chrome이 없으므로
    // 서버리스용으로 패키징된 Chromium을 사용한다.
    const sparticuz = (await import("@sparticuz/chromium")).default;
    return {
      headless: true,
      executablePath: await sparticuz.executablePath(),
      args: sparticuz.args,
    };
  }
  // 로컬 개발: 설치된 Chrome을 그대로 쓴다 (별도 다운로드 불필요).
  return { headless: true, channel: "chrome" };
}

async function launchBrowser(): Promise<Browser> {
  const { chromium } = await import("playwright-core");
  try {
    return await chromium.launch(await resolveLaunch());
  } catch (err) {
    // 로컬에서 시스템 Chrome이 없으면 playwright 패키지의 다운로드된 브라우저를 시도한다.
    if (env.isProduction || env.chromiumPath) throw err;
    const pw = await import("playwright").catch(() => null);
    if (!pw) {
      throw new AppError(
        errorCodes.EXTRACTION_FAILED,
        "헤드리스 브라우저를 사용할 수 없습니다. Chrome을 설치하거나 `pnpm playwright install chromium`을 실행하거나 CHROMIUM_PATH를 설정하세요.",
        500,
      );
    }
    try {
      return await pw.chromium.launch({ headless: true });
    } catch {
      throw new AppError(
        errorCodes.EXTRACTION_FAILED,
        "브라우저를 실행할 수 없습니다. `pnpm playwright install chromium`을 실행하거나 CHROMIUM_PATH를 설정하세요.",
        500,
      );
    }
  }
}

// JS로 목록을 채우는 사이트용: 실제 브라우저로 렌더링한 뒤 DOM HTML을 반환한다.
// fetchPage와 달리 실행 후의 DOM을 주므로 ETag/조건부 요청은 적용되지 않는다.
export async function renderPage(
  rawUrl: string,
  opts: RenderOptions = {},
): Promise<RenderedPage> {
  assertPublicUrl(rawUrl);
  const settleMs = opts.settleMs ?? SETTLE_TIMEOUT_MS;
  const stabilizeMs = opts.settleMs ?? MAX_STABILIZE_MS;
  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({
      userAgent: BROWSER_UA,
      locale: "ko-KR",
    });
    const page = await context.newPage();
    // 타임아웃이 나도 그 시점까지 로드된 DOM으로 추출을 시도하되,
    // 완료를 확인하지 못했다는 사실은 timeout으로 남긴다.
    let readyBy: RenderTimings["readyBy"] = "timeout";
    const startedAt = Date.now();
    try {
      await page.goto(rawUrl, {
        waitUntil: "domcontentloaded",
        timeout: GOTO_TIMEOUT_MS,
      });
      // 셀렉터가 잡히면 이후의 고정 대기(SPA 지연·안정화 폴링)가 모두 불필요하다.
      // 못 잡으면 셀렉터가 틀렸거나 페이지가 바뀐 것이므로 시간 기반 판정으로 되돌아간다.
      const selectorHit = opts.waitForSelector
        ? await page
            .waitForSelector(opts.waitForSelector, { timeout: settleMs })
            .then(() => true)
            .catch(() => false)
        : false;
      if (selectorHit) {
        readyBy = "selector";
      } else {
        readyBy = await settleByTime(page, settleMs, stabilizeMs);
      }
    } catch {
      // goto 실패: readyBy는 timeout 그대로 둔다.
    }
    const readyMs = Date.now() - startedAt;
    // 측정(readyMs)이 끝난 뒤에 스크롤한다. 스크롤 시간은 로딩 시간이 아니다.
    const grewByScroll = opts.scrollToBottom
      ? await scrollToBottom(page).catch(() => false)
      : false;
    const finalUrl = page.url();
    assertPublicUrl(finalUrl);
    const html = await page.content();
    if (html.length > MAX_HTML_BYTES) {
      throw new AppError(
        errorCodes.EXTRACTION_FAILED,
        "렌더링된 페이지가 너무 큽니다.",
        502,
      );
    }
    return { finalUrl, html, timings: { readyMs, readyBy, grewByScroll } };
  } finally {
    await browser.close().catch(() => {});
  }
}

// 시간 기반 로딩 완료 판정: 네트워크 유휴 → SPA 라우터 대기 → 다시 유휴 → DOM 안정화.
// readyMs에는 SPA_ROUTE_DELAY_MS와 안정화 폴링의 고정 대기가 포함된다. 실제 완료보다
// 크게 측정되는 쪽이므로 settleMs 여유계수와 겹쳐도 수집이 일찍 끊기는 일은 없다.
async function settleByTime(
  page: Page,
  settleMs: number,
  stabilizeMs: number,
): Promise<RenderTimings["readyBy"]> {
  // SPA가 데이터를 비동기로 채우므로 networkidle까지 기다린다.
  await page
    .waitForLoadState("networkidle", { timeout: settleMs })
    .catch(() => {});
  // hash 라우팅 SPA(#/path)는 초기 로드 후 라우터가 API를 호출하기까지
  // 시간이 걸린다. 첫 networkidle이 SPA 초기화 전에 발생할 수 있으므로
  // 짧은 대기 후 networkidle을 다시 기다려 SPA의 API 호출까지 잡는다.
  await page.waitForTimeout(SPA_ROUTE_DELAY_MS);
  const idle = await page
    .waitForLoadState("networkidle", { timeout: settleMs })
    .then(() => true)
    .catch(() => false);
  // networkidle 이후에도 DOM 렌더링이 진행 중일 수 있으므로
  // 내용이 안정될 때까지 폴링한다.
  if (await waitForDomStabilization(page, stabilizeMs)) return "stabilized";
  return idle ? "networkidle" : "timeout";
}

// 지연 로딩 목록: 문서 높이가 더 늘지 않을 때까지 끝으로 스크롤한다.
// 높이가 한 번이라도 늘었으면 true — 스크롤 없이는 항목이 부족하다는 근거가 된다.
async function scrollToBottom(page: Page): Promise<boolean> {
  let grew = false;
  let height = await page.evaluate(() => document.body.scrollHeight);
  for (let i = 0; i < MAX_SCROLLS; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(POLL_INTERVAL_MS);
    const next = await page.evaluate(() => document.body.scrollHeight);
    if (next <= height) break;
    grew = true;
    height = next;
  }
  return grew;
}

// SPA가 networkidle 이후에도 DOM을 계속 변경하는 경우,
// 페이지 내용이 더 이상 변하지 않을 때까지 폴링한다.
// hash 라우팅 SPA는 초기 로드 후 라우터가 API를 호출하고
// 렌더링을 완료하는 데 시간이 더 필요할 수 있다.
// 안정화되면 true, 시간 안에 안정되지 않으면 false.
async function waitForDomStabilization(
  page: Page,
  maxMs: number,
): Promise<boolean> {
  let lastContent = await page.content();
  let stable = 0;
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(POLL_INTERVAL_MS);
    const current = await page.content();
    if (current === lastContent) {
      if (++stable >= STABLE_POLLS) return true;
    } else {
      stable = 0;
      lastContent = current;
    }
  }
  return false;
}
