"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import type { Category, SourceDetail } from "@myportal/api-contracts";
import { api, isAuthError, ApiError } from "@/lib/api";
import { formatTimeHM, pad2, showToast } from "@/lib/shell";
import { Masthead } from "@/components/masthead";

const STATUS_LABELS: Record<string, string> = {
  ok: "정상",
  warn: "주의",
  fail: "실패",
  pause: "정지",
  link: "링크 전용",
};
const STATUS_STAMP: Record<string, string> = {
  ok: "stamp stamp-ok",
  warn: "stamp stamp-warn",
  fail: "stamp stamp-fail",
  pause: "stamp stamp-pause",
  link: "stamp stamp-link",
};
const STRATEGY_LABELS: Record<string, string> = {
  rss: "RSS",
  structured: "구조화",
  html: "정적 HTML",
  rendered: "렌더링",
  link: "링크 전용",
};
const TYPE_LABELS: Record<string, string> = {
  text: "텍스트",
  url: "URL",
  date: "날짜",
  datetime: "일시",
  date_range: "기간",
  number: "숫자",
  image: "이미지",
  tag_list: "태그 목록",
};
const ROLE_LABELS: Record<string, string> = {
  title: "제목",
  link: "링크",
  published: "게시일",
  deadline: "마감일",
  summary: "요약",
  none: "없음",
};

function fmtDT(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${pad2(d.getMonth() + 1)}.${pad2(d.getDate())} ${formatTimeHM(d)}`;
}

function intervalLabel(min: number): string {
  if (min < 60) return `${min}분`;
  if (min % 60 === 0) return `${min / 60}시간`;
  return `${(min / 60).toFixed(1)}시간`;
}

export default function SourceDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const sourceId = params.id;
  const [detail, setDetail] = useState<SourceDetail | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [selVersion, setSelVersion] = useState<number | null>(null);
  const [actionLog, setActionLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const log = useCallback((text: string) => {
    setActionLog((l) => [...l, `${formatTimeHM(new Date())} ${text}`]);
  }, []);

  const load = useCallback(() => {
    api.sources
      .detail(sourceId)
      .then((d) => {
        setDetail(d);
        setSelVersion(d.versions[0]?.version ?? null);
      })
      .catch((err) => {
        if (isAuthError(err)) router.replace("/login");
        else setNotFound(true);
      });
    api.categories.list().then(setCategories).catch(() => {});
  }, [sourceId, router]);

  useEffect(load, [load]);

  const categoriesById = useMemo(
    () => new Map(categories.map((c) => [c.id, c])),
    [categories],
  );
  const categoryPath = useCallback(
    (id: string | null): string => {
      if (!id) return "미분류";
      const c = categoriesById.get(id);
      if (!c) return "미분류";
      return c.parentId ? `${categoryPath(c.parentId)} › ${c.name}` : c.name;
    },
    [categoriesById],
  );

  async function collectNow() {
    if (busy) return;
    setBusy(true);
    log("지금 수집 요청 … 진행 중");
    try {
      const res = await api.sources.collectNow(sourceId);
      log(`지금 수집 완료 (신규 ${res.newCount}건)`);
      showToast(`수집을 완료했습니다 (신규 ${res.newCount}건)`);
      load();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "수집 실패";
      log(`지금 수집 실패 — ${msg}`);
      showToast(msg);
    } finally {
      setBusy(false);
    }
  }

  async function rebuildSpec() {
    if (busy) return;
    setBusy(true);
    log("명세 재생성 시도 … 진행 중");
    try {
      const res = await api.sources.rebuildSpec(sourceId);
      log(`명세 재생성 완료 (v${res.version} 적용)`);
      showToast(`새 명세 v${res.version}(으)로 교체했습니다`);
      load();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "재생성 실패";
      log(`명세 재생성 실패 — ${msg}`);
      showToast(msg);
    } finally {
      setBusy(false);
    }
  }

  if (notFound) {
    return (
      <div>
        <Masthead />
        <div className="px-6 py-5 text-ink-2" style={{ fontSize: 13 }}>
          소스를 찾을 수 없습니다.{" "}
          <Link href="/sources" className="text-blue underline">
            소스 목록으로
          </Link>
        </div>
      </div>
    );
  }
  if (!detail) {
    return (
      <div>
        <Masthead />
        <div className="px-6 py-5 font-mono text-ink-2" style={{ fontSize: 13 }}>
          불러오는 중…
        </div>
      </div>
    );
  }

  const sub = detail.subscription;
  const selectedVersion = detail.versions.find((v) => v.version === selVersion);

  return (
    <div>
      <Masthead />
      <div
        className="px-6 py-5"
        style={{ maxWidth: 1200, margin: "0 auto", paddingBottom: 48 }}
      >
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700 }}>
              {sub.displayName}
            </h1>
            <div className="font-mono text-ink-2 mt-1" style={{ fontSize: 12 }}>
              {sub.url}
            </div>
            <div className="flex items-center gap-2 mt-2">
              <span className={STATUS_STAMP[sub.status] ?? "stamp"}>
                {STATUS_LABELS[sub.status] ?? sub.status}
              </span>
              <span className="text-ink-2" style={{ fontSize: 11 }}>
                {categoryPath(sub.categoryId)}
              </span>
              <span className="font-mono text-ink-2" style={{ fontSize: 11 }}>
                {STRATEGY_LABELS[sub.fetchStrategy] ?? sub.fetchStrategy} ·{" "}
                {sub.paused ? "정지" : `${intervalLabel(sub.intervalMinutes)} 주기`}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="btn"
              disabled={busy || sub.fetchStrategy === "link"}
              onClick={() => void collectNow()}
            >
              지금 수집
            </button>
            <button
              className="btn"
              disabled={busy || sub.fetchStrategy === "link"}
              onClick={() => void rebuildSpec()}
            >
              명세 다시 만들기
            </button>
          </div>
        </div>

        {actionLog.length > 0 && (
          <div className="mt-2">
            {actionLog.map((l, i) => (
              <div
                key={i}
                className="font-mono text-ink-2"
                style={{ fontSize: 11 }}
              >
                {l}
              </div>
            ))}
          </div>
        )}

        <div className="rule-double" style={{ marginTop: 18 }} />

        {/* 필드 메타 */}
        <div style={{ marginTop: 30 }}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>
            필드 메타
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr className="text-ink-2" style={{ fontSize: 10, letterSpacing: "0.04em" }}>
                {["키", "표시명", "타입", "역할", "순서", "표시"].map((h) => (
                  <th
                    key={h}
                    style={{
                      textAlign: "left",
                      fontWeight: 500,
                      padding: "5px 8px",
                      borderBottom: "2px solid var(--ink)",
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {detail.fields.map((f) => (
                <tr key={f.key}>
                  <td className="font-mono" style={{ padding: "6px 8px", borderBottom: "1px solid var(--rule)" }}>
                    {f.key}
                  </td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--rule)" }}>
                    {f.label}
                  </td>
                  <td className="font-mono" style={{ padding: "6px 8px", borderBottom: "1px solid var(--rule)" }}>
                    {TYPE_LABELS[f.type] ?? f.type}
                  </td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--rule)" }}>
                    {ROLE_LABELS[f.role] ?? f.role}
                  </td>
                  <td className="font-mono" style={{ padding: "6px 8px", borderBottom: "1px solid var(--rule)" }}>
                    {f.sortOrder}
                  </td>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--rule)" }}>
                    {f.visible ? "표시" : "숨김"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="rule-double" style={{ marginTop: 30 }} />

        {/* 추출 명세 버전 이력 */}
        <div style={{ marginTop: 30 }}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>
            추출 명세 버전 이력
          </div>
          {detail.versions.length === 0 ? (
            <div className="text-ink-2" style={{ fontSize: 12 }}>
              저장된 명세가 없습니다.
            </div>
          ) : (
            <>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr className="text-ink-2" style={{ fontSize: 10, letterSpacing: "0.04em" }}>
                    {["버전", "생성 방식", "생성일", "활성"].map((h) => (
                      <th
                        key={h}
                        style={{
                          textAlign: "left",
                          fontWeight: 500,
                          padding: "5px 8px",
                          borderBottom: "2px solid var(--ink)",
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {detail.versions.map((v) => (
                    <tr
                      key={v.version}
                      className="cursor-pointer"
                      style={{
                        background:
                          v.version === selVersion ? "var(--paper-2)" : undefined,
                      }}
                      onClick={() => setSelVersion(v.version)}
                    >
                      <td className="font-mono" style={{ padding: "6px 8px", borderBottom: "1px solid var(--rule)" }}>
                        v{v.version}
                      </td>
                      <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--rule)" }}>
                        {v.createdBy}
                      </td>
                      <td className="font-mono" style={{ padding: "6px 8px", borderBottom: "1px solid var(--rule)" }}>
                        {v.createdAt.slice(0, 16).replace("T", " ")}
                      </td>
                      <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--rule)" }}>
                        {v.active && <span className="stamp stamp-ok">활성</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <pre
                className="mt-3"
                style={{
                  background: "var(--paper-2)",
                  border: "1px solid var(--rule)",
                  padding: 12,
                  fontFamily: "var(--font-code)",
                  fontSize: 11,
                  lineHeight: 1.5,
                  overflowX: "auto",
                  maxHeight: 360,
                  overflowY: "auto",
                }}
              >
                {selectedVersion
                  ? JSON.stringify(selectedVersion.spec, null, 2)
                  : "버전을 선택하세요"}
              </pre>
            </>
          )}
        </div>

        <div className="rule-double" style={{ marginTop: 30 }} />

        {/* 수집 실행 로그 */}
        <div style={{ marginTop: 30 }}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>
            수집 실행 로그
          </div>
          {detail.runs.length === 0 ? (
            <div className="text-ink-2" style={{ fontSize: 12 }}>
              수집 기록이 없습니다.
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr className="text-ink-2" style={{ fontSize: 10, letterSpacing: "0.04em" }}>
                  {["시각", "방식", "소요", "신규", "결과"].map((h) => (
                    <th
                      key={h}
                      style={{
                        textAlign: "left",
                        fontWeight: 500,
                        padding: "5px 8px",
                        borderBottom: "2px solid var(--ink)",
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {detail.runs.map((r) => (
                  <tr key={r.id}>
                    <td className="font-mono" style={{ padding: "6px 8px", borderBottom: "1px solid var(--rule)" }}>
                      {fmtDT(r.ranAt)}
                    </td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--rule)" }}>
                      {STRATEGY_LABELS[r.strategy] ?? r.strategy}
                    </td>
                    <td className="font-mono" style={{ padding: "6px 8px", borderBottom: "1px solid var(--rule)" }}>
                      {(r.durationMs / 1000).toFixed(1)}s
                    </td>
                    <td className="font-mono" style={{ padding: "6px 8px", borderBottom: "1px solid var(--rule)" }}>
                      {r.newCount}
                    </td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--rule)" }}>
                      {r.result === "ok" ? (
                        <span className="stamp stamp-ok">성공</span>
                      ) : r.result === "unchanged" ? (
                        <span className="stamp stamp-pause">변경 없음</span>
                      ) : (
                        <span className="stamp stamp-fail">{r.result}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="rule-double" style={{ marginTop: 30 }} />

        {/* 최근 항목 */}
        <div style={{ marginTop: 30 }}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>
            최근 항목
          </div>
          {detail.recentItems.length === 0 ? (
            <div className="text-ink-2" style={{ fontSize: 12 }}>
              최근 수집된 항목이 없습니다.
            </div>
          ) : (
            detail.recentItems.slice(0, 8).map((it) => (
              <div
                key={it.id}
                className="flex items-baseline justify-between gap-3 py-1.5"
                style={{ borderBottom: "1px solid var(--rule)" }}
              >
                <span style={{ fontSize: 13 }}>{it.title}</span>
                <span
                  className="font-mono text-ink-2 shrink-0"
                  style={{ fontSize: 11 }}
                >
                  {fmtDT(it.collectedAt)}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
