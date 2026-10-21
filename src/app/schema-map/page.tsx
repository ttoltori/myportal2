"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Category, Subscription } from "@myportal/api-contracts";
import { api, isAuthError } from "@/lib/api";
import { Masthead } from "@/components/masthead";

const COLUMNS = [
  { id: "title", label: "제목" },
  { id: "link", label: "링크" },
  { id: "published", label: "게시일" },
  { id: "deadline", label: "마감일" },
  { id: "summary", label: "요약" },
  { id: "thumbnail", label: "썸네일" },
  { id: "other", label: "기타 필드" },
] as const;

type ColId = (typeof COLUMNS)[number]["id"];

function cellValue(s: Subscription, colId: ColId): string | null {
  if (colId === "title") return "title";
  if (colId === "link") return "url";
  if (colId === "published") return "published_at";
  if (colId === "summary") return "excerpt";
  if (colId === "deadline")
    return s.fields.find((f) => f.role === "deadline")?.key ?? null;
  if (colId === "thumbnail")
    return s.fields.find((f) => f.type === "image")?.key ?? null;
  const others = s.fields
    .filter((f) => f.role !== "deadline" && f.type !== "image")
    .map((f) => f.key);
  return others.length ? others.join(", ") : null;
}

export default function SchemaMapPage() {
  const router = useRouter();
  const [subs, setSubs] = useState<Subscription[] | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [activeCol, setActiveCol] = useState<ColId | null>(null);

  useEffect(() => {
    Promise.all([api.subscriptions.list(), api.categories.list()])
      .then(([s, c]) => {
        setSubs(s);
        setCategories(c);
      })
      .catch((err) => {
        if (isAuthError(err)) router.replace("/login");
      });
  }, [router]);

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

  // 카테고리 트리 선행 순서
  const orderedCategoryIds = useMemo(() => {
    const out: string[] = [];
    const walk = (parentId: string | null) => {
      categories
        .filter((c) => c.parentId === parentId)
        .forEach((c) => {
          out.push(c.id);
          walk(c.id);
        });
    };
    walk(null);
    return out;
  }, [categories]);

  const groups = useMemo(() => {
    const list = subs ?? [];
    const gs = orderedCategoryIds
      .map((catId) => ({
        catId,
        sources: list
          .filter((s) => s.categoryId === catId)
          .sort((a, b) => a.displayName.localeCompare(b.displayName)),
      }))
      .filter((g) => g.sources.length > 0);
    const uncat = list
      .filter((s) => !s.categoryId)
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
    if (uncat.length) gs.push({ catId: "", sources: uncat });
    return gs;
  }, [subs, orderedCategoryIds]);

  const totalSources = subs?.length ?? 0;
  const deadlineCount = (subs ?? []).filter(
    (s) => cellValue(s, "deadline") !== null,
  ).length;
  const uniqueFieldCount = new Set(
    (subs ?? []).flatMap((s) => s.fields.map((f) => f.key)),
  ).size;

  return (
    <div>
      <Masthead />
      <div
        className="px-6 py-5"
        style={{ maxWidth: 1400, margin: "0 auto", paddingBottom: 48 }}
      >
        <h1 style={{ fontSize: 20, fontWeight: 700 }}>추출 항목</h1>
        <div className="rule-double" style={{ marginTop: 4, marginBottom: 6 }} />
        <div className="font-mono text-ink-2" style={{ fontSize: 11, marginBottom: 12 }}>
          소스 {totalSources} · 마감일 필드 보유 {deadlineCount} · 고유 필드{" "}
          {uniqueFieldCount}
        </div>

        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr>
                <th
                  style={{
                    minWidth: 180,
                    textAlign: "left",
                    fontSize: 11,
                    fontWeight: 500,
                    padding: "7px 10px",
                    borderBottom: "2px solid var(--ink)",
                  }}
                >
                  소스
                </th>
                {COLUMNS.map((col) => (
                  <th
                    key={col.id}
                    className="cursor-pointer select-none"
                    style={{
                      textAlign: "left",
                      fontSize: 11,
                      fontWeight: 500,
                      padding: "7px 10px",
                      borderBottom: "2px solid var(--ink)",
                      whiteSpace: "nowrap",
                      background:
                        activeCol === col.id ? "var(--rule)" : undefined,
                    }}
                    onClick={() =>
                      setActiveCol((a) => (a === col.id ? null : col.id))
                    }
                  >
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const shown = activeCol
                  ? g.sources.filter((s) => cellValue(s, activeCol) !== null)
                  : g.sources;
                if (!shown.length) return null;
                return (
                  <GroupRows
                    key={g.catId || "uncat"}
                    label={categoryPath(g.catId || null)}
                    sources={shown}
                    activeCol={activeCol}
                  />
                );
              })}
              {groups.every(
                (g) =>
                  activeCol &&
                  g.sources.every((s) => cellValue(s, activeCol) === null),
              ) &&
                subs !== null && (
                  <tr>
                    <td
                      colSpan={COLUMNS.length + 1}
                      className="text-ink-2"
                      style={{ padding: "16px 10px", fontFamily: "var(--font-sans)" }}
                    >
                      해당 필드를 가진 소스가 없습니다.
                    </td>
                  </tr>
                )}
              {subs !== null && subs.length === 0 && (
                <tr>
                  <td
                    colSpan={COLUMNS.length + 1}
                    className="text-ink-2"
                    style={{ padding: "16px 10px" }}
                  >
                    등록된 소스가 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function GroupRows({
  label,
  sources,
  activeCol,
}: {
  label: string;
  sources: Subscription[];
  activeCol: ColId | null;
}) {
  return (
    <>
      <tr>
        <td
          colSpan={COLUMNS.length + 1}
          style={{
            fontSize: 11,
            letterSpacing: "0.03em",
            color: "var(--ink-2)",
            background: "var(--paper-2)",
            borderBottom: "1px solid var(--rule)",
            padding: "5px 10px",
          }}
        >
          {label} ({sources.length})
        </td>
      </tr>
      {sources.map((s) => (
        <tr key={s.id}>
          <td
            style={{
              padding: "6px 10px",
              borderBottom: "1px solid var(--rule)",
              fontSize: 12,
              whiteSpace: "nowrap",
            }}
          >
            {s.displayName}
          </td>
          {COLUMNS.map((col) => {
            const v = cellValue(s, col.id);
            return (
              <td
                key={col.id}
                className="font-mono"
                style={{
                  padding: "6px 10px",
                  borderBottom: "1px solid var(--rule)",
                  fontSize: 11,
                  verticalAlign: "top",
                  color: v === null ? "var(--ink-2)" : undefined,
                  opacity: v === null ? 0.5 : undefined,
                  textAlign: v === null ? "center" : "left",
                  fontWeight: activeCol === col.id ? 500 : undefined,
                }}
              >
                {v === null ? "·" : v}
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}
