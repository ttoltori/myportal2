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

export interface RenderedPage {
  finalUrl: string;
  html: string;
}

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
export async function renderPage(rawUrl: string): Promise<RenderedPage> {
  assertPublicUrl(rawUrl);
  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({
      userAgent: BROWSER_UA,
      locale: "ko-KR",
    });
    const page = await context.newPage();
    try {
      await page.goto(rawUrl, {
        waitUntil: "domcontentloaded",
        timeout: GOTO_TIMEOUT_MS,
      });
      // SPA가 데이터를 비동기로 채우므로 networkidle까지 기다린다.
      await page
        .waitForLoadState("networkidle", { timeout: SETTLE_TIMEOUT_MS })
        .catch(() => {});
      // hash 라우팅 SPA(#/path)는 초기 로드 후 라우터가 API를 호출하기까지
      // 시간이 걸린다. 첫 networkidle이 SPA 초기화 전에 발생할 수 있으므로
      // 짧은 대기 후 networkidle을 다시 기다려 SPA의 API 호출까지 잡는다.
      await page.waitForTimeout(SPA_ROUTE_DELAY_MS);
      await page
        .waitForLoadState("networkidle", { timeout: SETTLE_TIMEOUT_MS })
        .catch(() => {});
      // networkidle 이후에도 DOM 렌더링이 진행 중일 수 있으므로
      // 내용이 안정될 때까지 폴링한다.
      await waitForDomStabilization(page);
    } catch {
      // 타임아웃이 나도 그 시점까지 로드된 DOM으로 추출을 시도한다.
    }
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
    return { finalUrl, html };
  } finally {
    await browser.close().catch(() => {});
  }
}

// SPA가 networkidle 이후에도 DOM을 계속 변경하는 경우,
// 페이지 내용이 더 이상 변하지 않을 때까지 폴링한다.
// hash 라우팅 SPA는 초기 로드 후 라우터가 API를 호출하고
// 렌더링을 완료하는 데 시간이 더 필요할 수 있다.
async function waitForDomStabilization(page: Page): Promise<void> {
  let lastContent = await page.content();
  let stable = 0;
  const deadline = Date.now() + MAX_STABILIZE_MS;
  while (Date.now() < deadline) {
    await page.waitForTimeout(POLL_INTERVAL_MS);
    const current = await page.content();
    if (current === lastContent) {
      if (++stable >= STABLE_POLLS) return;
    } else {
      stable = 0;
      lastContent = current;
    }
  }
}
