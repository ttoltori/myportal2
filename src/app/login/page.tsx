"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import {
  currentEffectiveTheme,
  formatTimeHM,
  showToast,
  toggleTheme,
} from "@/lib/shell";

const TELEGRAM_LINES = [
  { time: "07:14:02", text: "IITP 사업공고 ······················· 신규 1건 수신" },
  { time: "07:14:06", text: "AI타임스 ······················· 신규 3건 수신" },
  { time: "07:14:11", text: "로봇신문 ······················· 신규 2건 수신" },
  { time: "07:14:15", text: "GeekNews ······················· 신규 5건 수신" },
  { time: "07:14:20", text: "K-Startup 공고 ······················· 신규 1건 수신" },
];

function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return email;
  return email.charAt(0) + "***" + email.slice(at);
}

export default function LoginPage() {
  const [theme, setTheme] = useState<"dark" | "light">("light");
  const [shown, setShown] = useState(0);
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [sentAt, setSentAt] = useState("");
  const [devLink, setDevLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setTheme(currentEffectiveTheme());
    const timers = TELEGRAM_LINES.map((_, i) =>
      setTimeout(() => setShown(i + 1), 220 * i),
    );
    return () => timers.forEach(clearTimeout);
  }, []);

  async function submit() {
    const value = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      showToast("올바른 이메일 주소를 입력하세요");
      return;
    }
    setBusy(true);
    try {
      const res = await api.auth.requestMagicLink({ email: value });
      setSentAt(formatTimeHM(new Date()));
      setDevLink(res.devLink ?? null);
      setSent(true);
    } catch (err) {
      showToast(
        err instanceof ApiError ? err.message : "요청에 실패했습니다",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div
        style={{
          height: 52,
          borderBottom: "1px solid var(--ink)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 20px",
        }}
      >
        <span style={{ fontSize: 18, fontWeight: 700 }}>myportal</span>
        <div className="flex items-center gap-3">
          <span className="font-mono text-ink-2" style={{ fontSize: 11 }}>
            구독 신청
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setTheme(toggleTheme())}
          >
            {theme === "dark" ? "주간" : "야간"}
          </button>
        </div>
      </div>

      <div
        className="grid"
        style={{
          gridTemplateColumns: "minmax(0, 1.15fr) minmax(0, 1fr)",
          minHeight: "calc(100vh - 52px)",
        }}
      >
        {/* 좌측: 정체성 + 전보 */}
        <div
          style={{
            borderRight: "1px solid var(--rule)",
            padding: "48px 40px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
          }}
        >
          <div style={{ fontSize: 40, fontWeight: 700, lineHeight: 1.1 }}>
            myportal
          </div>
          <p
            className="mt-3"
            style={{
              fontSize: 14,
              lineHeight: 1.7,
              maxWidth: 420,
              color: "var(--ink-2)",
            }}
          >
            잊힌 사이트들이 보내오는 전문(電文)을 받아, 매일 한 장의 판면으로
            조판해 주는 나만의 외신 데스크.
          </p>

          <div
            className="text-ink-2 mt-6"
            style={{ fontSize: 10, letterSpacing: "0.04em" }}
          >
            수신 전보
          </div>
          <div
            style={{
              border: "1px solid var(--rule)",
              background: "var(--paper)",
              padding: "14px 16px",
              marginTop: 22,
            }}
          >
            {TELEGRAM_LINES.map((l, i) => (
              <div
                key={i}
                className="font-mono"
                style={{
                  fontSize: 12,
                  color: "var(--ink-2)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  padding: "2px 0",
                  opacity: i < shown ? 1 : 0,
                  transition: "opacity 300ms ease",
                }}
              >
                <span style={{ color: "var(--ink)", marginRight: 8 }}>
                  {l.time}
                </span>
                {l.text}
              </div>
            ))}
          </div>
        </div>

        {/* 우측: 구독 신청서 */}
        <div
          style={{
            padding: "48px 40px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            background: "var(--paper-2)",
          }}
        >
          {!sent ? (
            <div style={{ maxWidth: 360 }}>
              <h1 style={{ fontSize: 22, fontWeight: 700 }}>구독 신청서</h1>
              <p
                className="text-ink-2 mt-2"
                style={{ fontSize: 13, lineHeight: 1.6 }}
              >
                이메일로 로그인 링크를 보내드립니다. 링크를 열면 별도 비밀번호
                없이 접속됩니다.
              </p>

              <div className="mt-6">
                <label
                  className="text-ink-2"
                  style={{ fontSize: 11, letterSpacing: "0.03em" }}
                >
                  이메일
                </label>
                <input
                  type="email"
                  className="input-line"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void submit();
                    }
                  }}
                />
              </div>

              <button
                className="btn btn-primary mt-5"
                disabled={busy}
                onClick={() => void submit()}
              >
                {busy ? "전송 중…" : "로그인 링크 받기"}
              </button>

              <p
                className="text-ink-2 mt-4"
                style={{ fontSize: 11, lineHeight: 1.6 }}
              >
                myportal은 초대받은 이메일만 가입할 수 있습니다. 초대 없이 등록한
                이메일은 링크가 발송되지 않습니다.
              </p>
            </div>
          ) : (
            <div style={{ maxWidth: 360 }}>
              <h1 style={{ fontSize: 22, fontWeight: 700 }}>전송 완료</h1>
              <div
                className="font-mono mt-4"
                style={{
                  fontSize: 13,
                  color: "var(--ink)",
                  border: "1px solid var(--ink)",
                  padding: "10px 14px",
                  display: "inline-block",
                }}
              >
                {sentAt} 전송 완료 — {maskEmail(email)} 수신함을 확인하세요
              </div>
              <p
                className="text-ink-2 mt-4"
                style={{ fontSize: 13, lineHeight: 1.6 }}
              >
                받은편지함에서 myportal 로그인 링크를 확인해 주세요. 메일이
                보이지 않으면 스팸함도 확인하세요.
              </p>

              {devLink && (
                <div
                  className="mt-4"
                  style={{
                    border: "1px solid var(--amber)",
                    padding: "10px 14px",
                    fontSize: 12,
                  }}
                >
                  <div className="text-amber" style={{ fontWeight: 600 }}>
                    개발 모드 — 이메일 대신 이 링크로 로그인:
                  </div>
                  <a
                    href={devLink}
                    className="font-mono text-blue"
                    style={{ wordBreak: "break-all" }}
                  >
                    {devLink}
                  </a>
                </div>
              )}

              <div className="flex items-center gap-3 mt-5">
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    setSent(false);
                    void submit();
                  }}
                >
                  다시 보내기
                </button>
                <button className="btn btn-sm" onClick={() => setSent(false)}>
                  다른 이메일로 시도
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
