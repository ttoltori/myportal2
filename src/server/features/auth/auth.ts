import { createHash, randomBytes , timingSafeEqual } from "crypto";
import type { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { getDb } from "../../config/db";
import { env, hasMasterKey, hasSupabaseAuth } from "../../config/env";
import { authSql } from "./auth.sql";
import { AppError, errorCodes } from "../../errors/error-codes";

export const SESSION_COOKIE = "myportal_session";

const MAGIC_LINK_TTL_MIN = 30;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newToken(): string {
  return randomBytes(32).toString("hex");
}

function isEmailAllowed(email: string): boolean {
  if (env.allowedEmails.length === 0) return true;
  return env.allowedEmails.includes(email.toLowerCase());
}

async function provisionUser(email: string): Promise<string> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<{ id: string }>(authSql.upsertUser, [
      email,
    ]);
    const userId = rows[0].id;
    await tx.query(authSql.ensureUserSettings, [userId]);
    await tx.query(authSql.ensureUncategorized, [userId]);
    return userId;
  });
}

async function createSession(userId: string): Promise<string> {
  const db = getDb();
  const token = newToken();
  const expiresAt = new Date(
    Date.now() + env.sessionTtlDays * 24 * 60 * 60 * 1000,
  );
  await db.query(authSql.insertSession, [userId, hashToken(token), expiresAt]);
  return token;
}

export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: env.isProduction,
    maxAge: env.sessionTtlDays * 86400,
  });
}

// ---------- 비밀 문구 로그인 ----------

// 입력이 AUTH_MASTER_KEY와 일치하면 매직링크 없이 바로 세션을 만든다.
// 길이가 달라도 비교 시간이 새지 않도록 해시 후 timingSafeEqual을 쓴다
// (internal.routes.ts의 내부 인증과 같은 방식).
// 키는 어떤 경우에도 로그에 남기지 않는다.
export function isMasterKey(input: string): boolean {
  if (!hasMasterKey()) return false;
  const a = createHash("sha256").update(input).digest();
  const b = createHash("sha256").update(env.authMasterKey).digest();
  return timingSafeEqual(a, b);
}

// 비밀 문구가 맞을 때 호출한다. ALLOWED_EMAILS 검사는 건너뛴다 —
// 키를 아는 것 자체가 인가다.
export async function sessionForMasterKey(): Promise<{
  userId: string;
  sessionToken: string;
}> {
  const userId = await provisionUser(env.authMasterEmail);
  const sessionToken = await createSession(userId);
  return { userId, sessionToken };
}

// ---------- magic link ----------

export async function issueMagicLink(
  email: string,
): Promise<{ sent: boolean; devLink?: string }> {
  const normalized = email.trim().toLowerCase();
  // 계약에서 이메일 형식 검증을 뺐으므로(비밀 문구가 같은 칸을 쓴다) 여기서 본다.
  // 형식이 아니거나 허용 목록 밖이면 조용히 성공처럼 반환한다 —
  // 어떤 계정이 등록되어 있는지 노출하지 않기 위함이다.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
    return { sent: true };
  }
  if (!isEmailAllowed(normalized)) {
    return { sent: true };
  }

  if (hasSupabaseAuth() && !env.authDevMode) {
    const res = await fetch(`${env.supabaseUrl}/auth/v1/otp`, {
      method: "POST",
      headers: {
        apikey: env.supabaseServiceRoleKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: normalized,
        create_user: true,
        options: { emailRedirectTo: `${env.appBaseUrl}/auth/callback` },
      }),
    });
    if (!res.ok) {
      throw new AppError(
        errorCodes.EMAIL_SEND_FAILED,
        "로그인 메일 발송에 실패했습니다.",
        502,
      );
    }
    return { sent: true };
  }

  const db = getDb();
  const token = newToken();
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MIN * 60 * 1000);
  await db.query(authSql.insertMagicLink, [
    normalized,
    hashToken(token),
    expiresAt,
  ]);
  const link = `${env.appBaseUrl}/api/v1/auth/confirm?token=${token}`;

  if (env.authDevMode) {
    return { sent: true, devLink: link };
  }
  // 이메일 채널이 없으면 서버 로그에만 남긴다.
  console.log(`[myportal] magic link for ${normalized}: ${link}`);
  return { sent: true };
}

export async function confirmMagicLink(
  token: string,
): Promise<{ userId: string; sessionToken: string }> {
  const db = getDb();
  const { rows } = await db.query<{
    id: string;
    email: string;
    expires_at: string;
    used_at: string | null;
  }>(authSql.findMagicLink, [hashToken(token)]);

  const link = rows[0];
  if (!link || link.used_at || new Date(link.expires_at) < new Date()) {
    throw new AppError(
      errorCodes.INVALID_TOKEN,
      "로그인 링크가 만료되었거나 유효하지 않습니다.",
      401,
    );
  }
  await db.query(authSql.markMagicLinkUsed, [link.id]);
  const userId = await provisionUser(link.email);
  const sessionToken = await createSession(userId);
  return { userId, sessionToken };
}

// ---------- Supabase session exchange ----------

export async function sessionFromSupabase(
  accessToken: string,
): Promise<{ userId: string; sessionToken: string }> {
  if (!hasSupabaseAuth()) {
    throw new AppError(
      errorCodes.UNAUTHORIZED,
      "Supabase 인증이 설정되지 않았습니다.",
      401,
    );
  }
  const res = await fetch(`${env.supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: env.supabaseServiceRoleKey,
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!res.ok) {
    throw new AppError(
      errorCodes.UNAUTHORIZED,
      "Supabase 세션 검증에 실패했습니다.",
      401,
    );
  }
  const body = (await res.json()) as { email?: string };
  if (!body.email || !isEmailAllowed(body.email)) {
    throw new AppError(errorCodes.FORBIDDEN, "허용되지 않은 계정입니다.", 403);
  }
  const userId = await provisionUser(body.email.toLowerCase());
  const sessionToken = await createSession(userId);
  return { userId, sessionToken };
}

// ---------- session lookup / logout ----------

interface SessionRow {
  session_id: string;
  user_id: string;
  email: string;
  expires_at: string;
}

async function lookupSession(token: string): Promise<SessionRow | null> {
  const db = getDb();
  const { rows } = await db.query<SessionRow>(authSql.findSession, [
    hashToken(token),
  ]);
  const row = rows[0];
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  return row;
}

export async function logoutSession(token: string): Promise<void> {
  const db = getDb();
  await db.query(authSql.deleteSession, [hashToken(token)]);
}

function extractToken(c: Context): string | null {
  const bearer = c.req.header("authorization");
  if (bearer?.startsWith("Bearer ")) return bearer.slice(7);
  return getCookie(c)[SESSION_COOKIE] ?? null;
}

export function requireAuth() {
  return async (c: Context, next: Next) => {
    const token = extractToken(c);
    if (!token) {
      throw new AppError(
        errorCodes.UNAUTHORIZED,
        "로그인이 필요합니다.",
        401,
      );
    }
    const session = await lookupSession(token);
    if (!session) {
      throw new AppError(
        errorCodes.UNAUTHORIZED,
        "세션이 만료되었습니다. 다시 로그인해주세요.",
        401,
      );
    }
    c.set("userId", session.user_id);
    c.set("userEmail", session.email);
    await next();
  };
}

// ---------- route handlers ----------

export async function handleConfirm(c: Context) {
  const token = c.req.query("token");
  if (!token) {
    throw new AppError(
      errorCodes.INVALID_TOKEN,
      "토큰이 없습니다.",
      401,
    );
  }
  const { sessionToken } = await confirmMagicLink(token);
  setSessionCookie(c, sessionToken);
  return c.redirect("/", 302);
}

export async function handleSessionFromSupabase(
  c: Context,
  accessToken: string,
) {
  const { sessionToken } = await sessionFromSupabase(accessToken);
  setSessionCookie(c, sessionToken);
}

export async function handleLogout(c: Context) {
  const token = extractToken(c);
  if (token) await logoutSession(token);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export function getUserId(c: Context): string {
  const id = c.get("userId") as string | undefined;
  if (!id) {
    throw new AppError(errorCodes.UNAUTHORIZED, "로그인이 필요합니다.", 401);
  }
  return id;
}
