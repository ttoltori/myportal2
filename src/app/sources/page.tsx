"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Category, Subscription } from "@myportal/api-contracts";
import { api, isAuthError, ApiError } from "@/lib/api";
import { pad2, showToast } from "@/lib/shell";
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

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${pad2(d.getMonth() + 1)}.${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function intervalLabel(min: number): string {
  if (min < 60) return `${min}분`;
  if (min % 60 === 0) return `${min / 60}시간`;
  return `${(min / 60).toFixed(1)}시간`;
}

export default function SourcesPage() {
  const router = useRouter();
  const [subs, setSubs] = useState<Subscription[] | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [filters, setFilters] = useState({ status: "all", strategy: "all", text: "" });
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [bulkCategory, setBulkCategory] = useState("");
  const [bulkTag, setBulkTag] = useState("");

  const load = useCallback(() => {
    Promise.all([api.subscriptions.list(), api.categories.list()])
      .then(([s, c]) => {
        setSubs(s);
        setCategories(c);
        if (c.length) setBulkCategory(c[0].id);
      })
      .catch((err) => {
        if (isAuthError(err)) router.replace("/login");
        else showToast(err instanceof ApiError ? err.message : "불러오기 실패");
      });
  }, [router]);

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
      return c.parentId
        ? `${categoryPath(c.parentId)} › ${c.name}`
        : c.name;
    },
    [categoriesById],
  );

  const maxNew7d = Math.max(1, ...(subs ?? []).map((s) => s.new7d));

  const filtered = (subs ?? []).filter((s) => {
    if (filters.status !== "all" && s.status !== filters.status) return false;
    if (filters.strategy !== "all" && s.fetchStrategy !== filters.strategy)
      return false;
    const t = filters.text.trim().toLowerCase();
    if (
      t &&
      !s.displayName.toLowerCase().includes(t) &&
      !s.url.toLowerCase().includes(t)
    )
      return false;
    return true;
  });

  const selectedIds = Object.keys(selected).filter((k) => selected[k]);

  async function bulk(action: "move" | "tag" | "pause" | "unsubscribe") {
    if (!selectedIds.length) return;
    try {
      await api.subscriptions.bulk({
        subscriptionIds: selectedIds,
        action,
        categoryId: action === "move" ? bulkCategory : undefined,
        tagName: action === "tag" ? bulkTag.trim() : undefined,
      });
      const msg: Record<string, string> = {
        move: `${selectedIds.length}건을 ‘${categoryPath(bulkCategory)}’(으)로 이동했습니다`,
        tag: `${selectedIds.length}건에 태그 ‘${bulkTag.trim()}’ 부여했습니다`,
        pause: `${selectedIds.length}건을 일시정지했습니다`,
        unsubscribe: `${selectedIds.length}건 구독을 해제했습니다`,
      };
      showToast(msg[action]);
      setSelected({});
      setBulkTag("");
      load();
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "일괄 작업 실패");
    }
  }

  return (
    <div>
      <Masthead />
      <div className="px-6 py-5" style={{ maxWidth: 1560, margin: "0 auto" }}>
        <div className="flex items-baseline justify-between">
          <h1 style={{ fontSize: 20, fontWeight: 700 }}>소스</h1>
          <div className="font-mono text-ink-2" style={{ fontSize: 11 }}>
            전체 {subs?.length ?? 0}건 · 표시 {filtered.length}건
          </div>
        </div>
        <div className="rule-double" style={{ marginTop: 4, marginBottom: 12 }} />

        <div className="flex items-center gap-4 py-2 flex-wrap" style={{ fontSize: 12 }}>
          <label className="flex items-center gap-1 text-ink-2">
            상태
            <select
              className="input-line"
              style={{ width: "auto", padding: "2px 4px" }}
              value={filters.status}
              onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}
            >
              <option value="all">전체</option>
              <option value="ok">정상</option>
              <option value="warn">주의</option>
              <option value="fail">실패</option>
              <option value="pause">정지</option>
              <option value="link">링크 전용</option>
            </select>
          </label>
          <label className="flex items-center gap-1 text-ink-2">
            수집 방식
            <select
              className="input-line"
              style={{ width: "auto", padding: "2px 4px" }}
              value={filters.strategy}
              onChange={(e) =>
                setFilters((f) => ({ ...f, strategy: e.target.value }))
              }
            >
              <option value="all">전체</option>
              <option value="rss">RSS</option>
              <option value="structured">구조화</option>
              <option value="html">정적 HTML</option>
              <option value="rendered">렌더링</option>
              <option value="link">링크 전용</option>
            </select>
          </label>
          <label
            className="flex items-center gap-1 text-ink-2 flex-1"
            style={{ minWidth: 200, maxWidth: 320 }}
          >
            검색
            <input
              className="input-line"
              style={{ fontSize: 12 }}
              placeholder="표시명 또는 URL"
              value={filters.text}
              onChange={(e) => setFilters((f) => ({ ...f, text: e.target.value }))}
            />
          </label>
        </div>

        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr className="text-ink-2" style={{ borderBottom: "1px solid var(--ink)", fontSize: 11 }}>
              <th style={{ width: 28, textAlign: "left", padding: "6px 4px" }}>
                <input
                  type="checkbox"
                  checked={
                    filtered.length > 0 &&
                    filtered.every((s) => selected[s.id])
                  }
                  onChange={(e) => {
                    const next = { ...selected };
                    filtered.forEach((s) => {
                      if (e.target.checked) next[s.id] = true;
                      else delete next[s.id];
                    });
                    setSelected(next);
                  }}
                />
              </th>
              <th style={{ textAlign: "left", padding: "6px 4px" }}>표시명</th>
              <th style={{ textAlign: "left", padding: "6px 4px" }}>카테고리</th>
              <th style={{ textAlign: "left", padding: "6px 4px" }}>수집 방식</th>
              <th style={{ textAlign: "left", padding: "6px 4px" }}>상태</th>
              <th style={{ textAlign: "left", padding: "6px 4px" }}>마지막 성공</th>
              <th style={{ textAlign: "left", padding: "6px 4px" }}>7일 신규</th>
              <th style={{ textAlign: "left", padding: "6px 4px" }}>수집 주기</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((s) => {
              const on = Math.round((s.new7d / maxNew7d) * 10);
              return (
                <tr
                  key={s.id}
                  className="cursor-pointer"
                  style={{ borderBottom: "1px solid var(--rule)" }}
                  onClick={() => router.push(`/sources/${s.sourceId}`)}
                >
                  <td style={{ padding: "6px 4px" }}>
                    <input
                      type="checkbox"
                      checked={!!selected[s.id]}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) =>
                        setSelected((m) => {
                          const next = { ...m };
                          if (e.target.checked) next[s.id] = true;
                          else delete next[s.id];
                          return next;
                        })
                      }
                    />
                  </td>
                  <td style={{ padding: "6px 4px" }}>
                    <Link
                      href={`/sources/${s.sourceId}`}
                      style={{ fontSize: 13 }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {s.displayName}
                    </Link>
                    <div className="font-mono text-ink-2" style={{ fontSize: 10 }}>
                      {s.url}
                    </div>
                  </td>
                  <td style={{ padding: "6px 4px" }}>{categoryPath(s.categoryId)}</td>
                  <td style={{ padding: "6px 4px" }}>
                    {STRATEGY_LABELS[s.fetchStrategy] ?? s.fetchStrategy}
                  </td>
                  <td style={{ padding: "6px 4px" }}>
                    <span className={STATUS_STAMP[s.status] ?? "stamp"}>
                      {STATUS_LABELS[s.status] ?? s.status}
                    </span>
                  </td>
                  <td className="font-mono" style={{ padding: "6px 4px" }}>
                    {formatDateTime(s.lastSuccessAt)}
                  </td>
                  <td className="font-mono" style={{ padding: "6px 4px" }}>
                    {s.new7d}
                    <span style={{ display: "inline-flex", gap: 1, marginLeft: 6 }}>
                      {Array.from({ length: 10 }, (_, i) => (
                        <span
                          key={i}
                          style={{
                            width: 4,
                            height: 10,
                            display: "inline-block",
                            background:
                              i < on ? "var(--red)" : "var(--rule)",
                          }}
                        />
                      ))}
                    </span>
                  </td>
                  <td className="font-mono" style={{ padding: "6px 4px" }}>
                    {s.paused ? "정지" : intervalLabel(s.intervalMinutes)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {subs !== null && filtered.length === 0 && (
          <div className="text-ink-2 py-6" style={{ fontSize: 13 }}>
            조건에 맞는 소스가 없습니다.
          </div>
        )}
      </div>

      {/* 일괄 작업 띠 */}
      {selectedIds.length > 0 && (
        <div
          className="font-mono"
          style={{
            position: "fixed",
            left: 0,
            right: 0,
            bottom: 0,
            background: "var(--ink)",
            color: "var(--paper)",
            fontSize: 12,
            padding: "10px 20px",
            display: "flex",
            alignItems: "center",
            gap: 16,
            zIndex: 150,
          }}
        >
          <span>{selectedIds.length}건 선택됨</span>
          <label className="flex items-center gap-1">
            카테고리 이동
            <select
              value={bulkCategory}
              onChange={(e) => setBulkCategory(e.target.value)}
              style={{ background: "var(--ink)", color: "var(--paper)", border: "1px solid var(--paper)" }}
            >
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {categoryPath(c.id)}
                </option>
              ))}
            </select>
          </label>
          <button
            onClick={() => void bulk("move")}
            style={{ border: "1px solid var(--paper)", padding: "3px 10px", background: "none", color: "var(--paper)", cursor: "pointer" }}
          >
            이동
          </button>
          <label className="flex items-center gap-1">
            태그 부여
            <input
              value={bulkTag}
              onChange={(e) => setBulkTag(e.target.value)}
              placeholder="태그명"
              style={{ width: 100, background: "var(--ink)", color: "var(--paper)", border: "1px solid var(--paper)", padding: "2px 6px" }}
            />
          </label>
          <button
            onClick={() => void bulk("tag")}
            style={{ border: "1px solid var(--paper)", padding: "3px 10px", background: "none", color: "var(--paper)", cursor: "pointer" }}
          >
            부여
          </button>
          <button
            onClick={() => void bulk("pause")}
            style={{ border: "1px solid var(--paper)", padding: "3px 10px", background: "none", color: "var(--paper)", cursor: "pointer" }}
          >
            일시정지
          </button>
          <button
            onClick={() => void bulk("unsubscribe")}
            style={{ border: "1px solid var(--paper)", padding: "3px 10px", background: "none", color: "var(--paper)", cursor: "pointer" }}
          >
            구독 해제
          </button>
          <div className="flex-1" />
          <button
            onClick={() => setSelected({})}
            style={{ border: "1px solid var(--paper)", padding: "3px 10px", background: "none", color: "var(--paper)", cursor: "pointer" }}
          >
            선택 해제
          </button>
        </div>
      )}
    </div>
  );
}
