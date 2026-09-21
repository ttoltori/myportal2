"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  Category,
  DigestPreview,
  DigestRun,
  DigestSettings,
} from "@myportal/api-contracts";
import { api, isAuthError, ApiError } from "@/lib/api";
import { showToast } from "@/lib/shell";
import { Masthead } from "@/components/masthead";
import { useResizable } from "@/components/desk/use-resizable";

const WEEKDAY = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"];
const RESULT_LABEL: Record<string, string> = {
  ok: "성공",
  fail: "실패",
  skipped: "미발송 (새 항목 없음)",
  queued: "대기",
};
const RESULT_STAMP: Record<string, string> = {
  ok: "stamp stamp-ok",
  fail: "stamp stamp-fail",
  skipped: "stamp stamp-pause",
  queued: "stamp stamp-pause",
};
const STATUS_LABELS: Record<string, string> = {
  ok: "정상",
  warn: "주의",
  fail: "실패",
  pause: "정지",
  link: "링크 전용",
};

const fieldLabel: React.CSSProperties = {
  fontSize: 11,
  letterSpacing: "0.03em",
  color: "var(--ink-2)",
  marginBottom: 4,
  marginTop: 16,
};

function dday(deadlineAt: string | null): { label: string; cls: string } | null {
  if (!deadlineAt) return null;
  const diff = Math.ceil(
    (new Date(deadlineAt).getTime() - Date.now()) / 86400000,
  );
  if (diff < 0) return { label: "마감", cls: "dday dday-past" };
  if (diff === 0) return { label: "D-DAY", cls: "dday dday-urgent" };
  return { label: `D-${diff}`, cls: diff <= 3 ? "dday dday-urgent" : "dday" };
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return email;
  return `${local[0] ?? ""}***@${domain}`;
}

export default function DigestPage() {
  const router = useRouter();
  const appRef = useRef<HTMLDivElement>(null);
  useResizable(appRef, "myportal-resize-digest", {
    panes: [{ default: 380, min: 300, max: 600 }, { min: 640 }],
    flexIndex: 1,
  });

  const [settings, setSettings] = useState<DigestSettings | null>(null);
  const [history, setHistory] = useState<DigestRun[]>([]);
  const [email, setEmail] = useState("");
  const [categories, setCategories] = useState<Category[]>([]);
  const [preview, setPreview] = useState<DigestPreview | null>(null);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);

  const load = useCallback(() => {
    Promise.all([api.digest.getSettings(), api.categories.list()])
      .then(([d, c]) => {
        setSettings(d.settings);
        setHistory(d.history);
        setEmail(d.email);
        setCategories(c);
      })
      .catch((err) => {
        if (isAuthError(err)) router.replace("/login");
      });
    api.digest
      .preview()
      .then(setPreview)
      .catch(() => setPreview(null));
  }, [router]);

  useEffect(load, [load]);

  const update = useCallback(
    (patch: Partial<DigestSettings>, toastMsg?: string) => {
      setSettings((s) => {
        if (!s) return s;
        const next = { ...s, ...patch };
        setSaving(true);
        api.digest
          .updateSettings(next)
          .then(() => toastMsg && showToast(toastMsg))
          .catch((err) =>
            showToast(err instanceof ApiError ? err.message : "저장 실패"),
          )
          .finally(() => setSaving(false));
        return next;
      });
    },
    [],
  );

  const topCategories = categories.filter((c) => !c.parentId);

  async function sendNow() {
    if (sending) return;
    setSending(true);
    try {
      const res = await api.digest.sendNow();
      showToast(
        res.sent
          ? `다이제스트를 발송했습니다 (${res.itemCount}건)`
          : "발송할 새 항목이 없어 건너뛰었습니다",
      );
      load();
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "발송 실패");
    } finally {
      setSending(false);
    }
  }

  const mastheadDate = preview
    ? (() => {
        const d = new Date(preview.generatedAt);
        return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
      })()
    : "";

  return (
    <div>
      <Masthead />
      <div
        ref={appRef}
        style={{
          display: "grid",
          gridTemplateColumns: "var(--pane-0-width, 380px) minmax(640px, 1fr)",
          height: "calc(100vh - 44px)",
        }}
      >
        {/* 좌측: 설정 */}
        <aside
          className="bg-paper-2"
          style={{ borderRight: "1px solid var(--rule)", overflowY: "auto" }}
        >
          <div className="p-4" style={{ maxWidth: 380 }}>
            <div className="flex items-center justify-between">
              <h1 style={{ fontSize: 18, fontWeight: 700 }}>다이제스트 설정</h1>
              <button
                className="btn btn-sm"
                disabled={sending || !settings?.enabled}
                onClick={() => void sendNow()}
              >
                {sending ? "발송 중…" : "지금 발송"}
              </button>
            </div>

            {settings && (
              <>
                <label className="flex items-center gap-2 mt-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.enabled}
                    onChange={(e) => update({ enabled: e.target.checked })}
                  />
                  <span style={{ fontSize: 13, fontWeight: 500 }}>
                    다이제스트 사용
                  </span>
                  {saving && (
                    <span className="font-mono text-ink-2" style={{ fontSize: 10 }}>
                      저장 중…
                    </span>
                  )}
                </label>

                <div style={fieldLabel}>발송 주기</div>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-1" style={{ fontSize: 13 }}>
                    <input
                      type="radio"
                      name="freq"
                      checked={settings.frequency === "daily"}
                      onChange={() => update({ frequency: "daily" })}
                    />{" "}
                    매일
                  </label>
                  <label className="flex items-center gap-1" style={{ fontSize: 13 }}>
                    <input
                      type="radio"
                      name="freq"
                      checked={settings.frequency === "weekly"}
                      onChange={() => update({ frequency: "weekly" })}
                    />{" "}
                    매주
                  </label>
                  {settings.frequency === "weekly" && (
                    <select
                      className="input-line"
                      style={{ width: "auto", padding: "4px 6px", fontSize: 12 }}
                      value={settings.weekday}
                      onChange={(e) =>
                        update({ weekday: Number(e.target.value) })
                      }
                    >
                      {WEEKDAY.map((w, i) => (
                        <option key={i} value={i}>
                          {w}
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                <div style={fieldLabel}>발송 시각</div>
                <input
                  type="time"
                  className="input-line"
                  style={{ width: "auto" }}
                  value={settings.time}
                  onChange={(e) =>
                    update(
                      { time: e.target.value },
                      `발송 시각을 ${e.target.value}로 저장했습니다`,
                    )
                  }
                />

                <div style={fieldLabel}>시간대</div>
                <div className="font-mono text-ink-2" style={{ fontSize: 12 }}>
                  {settings.timezone} (고정)
                </div>

                <div style={fieldLabel}>포함 카테고리</div>
                <div style={{ fontSize: 13 }}>
                  {topCategories.map((c) => (
                    <label
                      key={c.id}
                      className="flex items-center gap-2 py-0.5 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={settings.categories.includes(c.id)}
                        onChange={(e) =>
                          update({
                            categories: e.target.checked
                              ? [...settings.categories, c.id]
                              : settings.categories.filter(
                                  (x) => x !== c.id,
                                ),
                          })
                        }
                      />
                      <span>{c.name}</span>
                    </label>
                  ))}
                </div>

                <div style={fieldLabel}>항목 수 상한</div>
                <input
                  type="number"
                  min={1}
                  max={50}
                  className="input-line"
                  style={{ width: 80 }}
                  value={settings.limit}
                  onChange={(e) =>
                    update({
                      limit: Math.max(
                        1,
                        Math.min(50, Number(e.target.value) || 10),
                      ),
                    })
                  }
                />

                <div style={fieldLabel}>수신 이메일</div>
                <div className="font-mono" style={{ fontSize: 13 }}>
                  {maskEmail(email)}
                </div>

                <div style={fieldLabel}>발송 이력</div>
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: 12,
                  }}
                >
                  <thead>
                    <tr className="text-ink-2" style={{ fontSize: 11 }}>
                      <th style={{ textAlign: "left", fontWeight: 500, borderBottom: "1px solid var(--ink)", padding: "4px 6px 4px 0" }}>
                        날짜
                      </th>
                      <th className="font-mono" style={{ textAlign: "left", fontWeight: 500, borderBottom: "1px solid var(--ink)", padding: "4px 6px 4px 0" }}>
                        항목 수
                      </th>
                      <th style={{ textAlign: "left", fontWeight: 500, borderBottom: "1px solid var(--ink)", padding: "4px 6px 4px 0" }}>
                        결과
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((h) => (
                      <tr key={h.id}>
                        <td className="font-mono" style={{ borderBottom: "1px solid var(--rule)", padding: "5px 6px 5px 0" }}>
                          {h.ranAt.slice(5, 10).replace("-", ".")}
                        </td>
                        <td className="font-mono" style={{ borderBottom: "1px solid var(--rule)", padding: "5px 6px 5px 0" }}>
                          {h.itemCount}
                        </td>
                        <td style={{ borderBottom: "1px solid var(--rule)", padding: "5px 6px 5px 0" }}>
                          <span className={RESULT_STAMP[h.result] ?? "stamp"}>
                            {RESULT_LABEL[h.result] ?? h.result}
                          </span>
                        </td>
                      </tr>
                    ))}
                    {history.length === 0 && (
                      <tr>
                        <td colSpan={3} className="text-ink-2" style={{ padding: "8px 0", fontSize: 12 }}>
                          발송 이력이 없습니다.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </>
            )}
          </div>
        </aside>

        {/* 우측: 이메일 미리보기 */}
        <main className="bg-paper-2" style={{ overflowY: "auto" }}>
          <div className="px-6 py-6">
            <div className="text-ink-2 mb-3" style={{ fontSize: 12 }}>
              이메일 미리보기 — 실제 수집 데이터 기준입니다.
            </div>
            <div
              style={{
                width: 640,
                maxWidth: "100%",
                background: "var(--paper)",
                border: "1px solid var(--ink)",
                margin: "0 auto",
              }}
            >
              <div
                style={{
                  borderBottom: "3px double var(--ink)",
                  padding: "14px 20px 10px",
                  textAlign: "center",
                }}
              >
                <div style={{ fontSize: 22, fontWeight: 700 }}>myportal 조간</div>
                {settings?.enabled !== false && (
                  <div className="font-mono text-ink-2 mt-1" style={{ fontSize: 11 }}>
                    {mastheadDate}
                  </div>
                )}
              </div>

              {settings?.enabled === false ? (
                <div
                  className="text-ink-2"
                  style={{ padding: "40px 20px", textAlign: "center", fontSize: 13 }}
                >
                  다이제스트 사용이 꺼져 있습니다. 이메일이 발송되지 않습니다.
                </div>
              ) : !preview ? (
                <div
                  className="font-mono text-ink-2"
                  style={{ padding: "40px 20px", textAlign: "center", fontSize: 12 }}
                >
                  불러오는 중…
                </div>
              ) : (
                <>
                  <div style={{ borderBottom: "2px solid var(--ink)", padding: "14px 20px 4px" }}>
                    <span style={{ fontSize: 14, fontWeight: 700 }}>① 키워드 알림</span>
                  </div>
                  {preview.alertItems.length === 0 ? (
                    <div className="text-ink-2" style={{ padding: "8px 20px", fontSize: 12 }}>
                      최근 알림 키워드에 걸린 항목이 없습니다.
                    </div>
                  ) : (
                    preview.alertItems.map((it) => (
                      <div key={it.id} style={{ padding: "8px 20px", borderBottom: "1px solid var(--rule)" }}>
                        <div style={{ fontSize: 13, fontWeight: 500 }}>{it.title}</div>
                        <div className="font-mono text-ink-2 mt-1" style={{ fontSize: 11 }}>
                          {it.collectedAt.slice(11, 16)}
                        </div>
                      </div>
                    ))
                  )}

                  <div style={{ borderBottom: "2px solid var(--ink)", padding: "14px 20px 4px", marginTop: 10 }}>
                    <span style={{ fontSize: 14, fontWeight: 700 }}>
                      ② 마감 임박 공고 (D-7 이내)
                    </span>
                  </div>
                  {preview.deadlineItems.length === 0 ? (
                    <div className="text-ink-2" style={{ padding: "8px 20px", fontSize: 12 }}>
                      7일 이내 마감되는 공고가 없습니다.
                    </div>
                  ) : (
                    preview.deadlineItems.map((it) => {
                      const dd = dday(it.deadlineAt);
                      return (
                        <div key={it.id} style={{ padding: "8px 20px", borderBottom: "1px solid var(--rule)" }}>
                          <div className="flex items-center gap-2">
                            {dd && <span className={dd.cls}>{dd.label}</span>}
                            <span style={{ fontSize: 13, fontWeight: 500 }}>{it.title}</span>
                          </div>
                        </div>
                      );
                    })
                  )}

                  <div style={{ borderBottom: "2px solid var(--ink)", padding: "14px 20px 4px", marginTop: 10 }}>
                    <span style={{ fontSize: 14, fontWeight: 700 }}>③ 카테고리별 새 글</span>
                  </div>
                  {preview.categorySections.length === 0 ? (
                    <div className="text-ink-2" style={{ padding: "8px 20px", fontSize: 12 }}>
                      선택된 카테고리가 없습니다.
                    </div>
                  ) : (
                    preview.categorySections.map((sec) => (
                      <div key={sec.categoryId} style={{ padding: "8px 20px", borderBottom: "1px solid var(--rule)" }}>
                        <div className="flex items-baseline justify-between">
                          <span style={{ fontSize: 13, fontWeight: 500 }}>{sec.name}</span>
                          <span className="font-mono" style={{ fontSize: 12, color: "var(--red)" }}>
                            {sec.count}건
                          </span>
                        </div>
                        {sec.topItems.length === 0 ? (
                          <div className="text-ink-2 mt-1" style={{ fontSize: 12 }}>
                            새 글 없음
                          </div>
                        ) : (
                          sec.topItems.map((it) => (
                            <div key={it.id} className="mt-1" style={{ fontSize: 12 }}>
                              · {it.title}
                            </div>
                          ))
                        )}
                      </div>
                    ))
                  )}

                  <div style={{ borderBottom: "2px solid var(--ink)", padding: "14px 20px 4px", marginTop: 10 }}>
                    <span style={{ fontSize: 14, fontWeight: 700 }}>④ 주의 소스 안내</span>
                  </div>
                  {preview.warnSources.length === 0 ? (
                    <div className="text-ink-2" style={{ padding: "8px 20px", fontSize: 12 }}>
                      주의가 필요한 소스가 없습니다.
                    </div>
                  ) : (
                    preview.warnSources.map((s) => (
                      <div
                        key={s.subscriptionId}
                        className="flex items-center justify-between"
                        style={{ padding: "8px 20px", borderBottom: "1px solid var(--rule)" }}
                      >
                        <span style={{ fontSize: 13 }}>{s.name}</span>
                        <span className={`stamp ${s.status === "fail" ? "stamp-fail" : "stamp-warn"}`}>
                          {STATUS_LABELS[s.status] ?? s.status}
                        </span>
                      </div>
                    ))
                  )}

                  <div
                    className="text-ink-2"
                    style={{
                      borderTop: "2px solid var(--ink)",
                      padding: "12px 20px",
                      textAlign: "center",
                      fontSize: 11,
                    }}
                  >
                    {maskEmail(email)} 로 발송됨
                  </div>
                </>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
