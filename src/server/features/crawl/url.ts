import { createHash } from "crypto";
import { AppError, errorCodes } from "../../errors/error-codes";

const TRACKING_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
  "ocid",
];

export function normalizeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new AppError(errorCodes.INVALID_URL, "유효하지 않은 URL입니다.", 400);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppError(
      errorCodes.INVALID_URL,
      "http/https URL만 지원합니다.",
      400,
    );
  }
  url.hash = "";
  for (const p of TRACKING_PARAMS) url.searchParams.delete(p);
  url.hostname = url.hostname.toLowerCase();
  if (
    (url.protocol === "https:" && url.port === "443") ||
    (url.protocol === "http:" && url.port === "80")
  ) {
    url.port = "";
  }
  // 경로 끝 슬래시 정규화 (루트 '/'는 유지)
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  url.searchParams.sort();
  return url.toString();
}

const PRIVATE_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "metadata.google.internal",
  "169.254.169.254",
]);

function isPrivateIp(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "");
  if (PRIVATE_HOSTNAMES.has(h)) return true;
  if (h.endsWith(".local") || h.endsWith(".internal")) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a >= 224) return true; // multicast/reserved
  }
  if (h.includes(":")) {
    // IPv6: loopback/link-local/private ranges
    if (h === "::1" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) {
      return true;
    }
  }
  return false;
}

// SSRF 방어: 공개 http(s) 호스트만 허용한다 (요건정의서 §8 보안 제약).
export function assertPublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError(errorCodes.INVALID_URL, "유효하지 않은 URL입니다.", 400);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppError(
      errorCodes.INVALID_URL,
      "http/https URL만 지원합니다.",
      400,
    );
  }
  if (url.username || url.password) {
    throw new AppError(
      errorCodes.INVALID_URL,
      "인증 정보가 포함된 URL은 사용할 수 없습니다.",
      400,
    );
  }
  if (isPrivateIp(url.hostname)) {
    throw new AppError(
      errorCodes.INVALID_URL,
      "내부 네트워크 주소는 수집할 수 없습니다.",
      400,
    );
  }
  return url;
}

// 상대/프로토콜-상대 링크를 기준 URL의 절대 경로로 변환한다.
// 해석 불가능한 값은 null을 반환한다 (호출부에서 필터링).
export function absolutize(href: string, baseUrl: string): string | null {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("javascript:") || trimmed.startsWith("#")) {
    return null;
  }
  try {
    const resolved = new URL(trimmed, baseUrl);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      return null;
    }
    return resolved.toString();
  } catch {
    return null;
  }
}

export function dedupeHash(sourceUrl: string, title: string): string {
  const key = title.trim().toLowerCase().replace(/\s+/g, " ");
  return createHash("sha256")
    .update(`${sourceUrl}::${key}`)
    .digest("hex")
    .slice(0, 32);
}

export function titleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter((w) => w.length > 1)
    .slice(0, 12)
    .join(" ");
}
