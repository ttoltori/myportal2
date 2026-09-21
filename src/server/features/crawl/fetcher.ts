import { env } from "../../config/env";
import { AppError, errorCodes } from "../../errors/error-codes";
import { assertPublicUrl } from "./url";

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export interface FetchResult {
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  etag: string | null;
  lastModified: string | null;
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return res.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new AppError(
        errorCodes.EXTRACTION_FAILED,
        "응답 크기가 너무 큽니다.",
        502,
      );
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder("utf-8").decode(merged);
}

export async function fetchPage(
  rawUrl: string,
  opts: { etag?: string | null; lastModified?: string | null } = {},
): Promise<FetchResult> {
  assertPublicUrl(rawUrl);

  const headers: Record<string, string> = {
    "User-Agent": env.crawlUserAgent,
    Accept:
      "text/html,application/xhtml+xml,application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ko,en;q=0.9",
  };
  if (opts.etag) headers["If-None-Match"] = opts.etag;
  if (opts.lastModified) headers["If-Modified-Since"] = opts.lastModified;

  let url = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new AppError(
        errorCodes.URL_UNREACHABLE,
        "URL에 연결할 수 없습니다.",
        502,
        err instanceof Error ? err.message : String(err),
      );
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) break;
      url = new URL(loc, url).toString();
      assertPublicUrl(url); // 리다이렉트 목적지도 검증
      continue;
    }

    if (res.status === 304) {
      return {
        finalUrl: url,
        status: 304,
        contentType: "",
        body: "",
        etag: opts.etag ?? null,
        lastModified: opts.lastModified ?? null,
      };
    }

    if (res.status === 429 || res.status === 503) {
      throw new AppError(
        errorCodes.RATE_LIMITED,
        "대상 사이트가 요청을 제한했습니다.",
        429,
      );
    }
    if (!res.ok) {
      throw new AppError(
        errorCodes.URL_UNREACHABLE,
        `페이지 요청이 실패했습니다. (HTTP ${res.status})`,
        502,
      );
    }

    const contentType = res.headers.get("content-type") ?? "";
    const body = await readCapped(res);
    return {
      finalUrl: url,
      status: res.status,
      contentType,
      body,
      etag: res.headers.get("etag"),
      lastModified: res.headers.get("last-modified"),
    };
  }
  throw new AppError(
    errorCodes.URL_UNREACHABLE,
    "리다이렉트가 너무 많습니다.",
    502,
  );
}
