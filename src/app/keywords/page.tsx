"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  Category,
  KeywordRule,
  RuleAction,
  RuleScopeType,
  Tag,
  Item,
} from "@myportal/api-contracts";
import { api, isAuthError, ApiError } from "@/lib/api";
import { showToast } from "@/lib/shell";
import { Masthead } from "@/components/masthead";
import { useResizable } from "@/components/desk/use-resizable";

const ACTION_ORDER: RuleAction[] = ["emphasize", "alert", "mute"];
const ACTION_LABELS: Record<RuleAction, string> = {
  emphasize: "강조",
  alert: "알림",
  mute: "뮤트",
};
const ACTION_DESC: Record<RuleAction, string> = {
  emphasize: "강조: 목록에서 표시·상단 정렬",
  alert: "알림: 키워드 알림 뷰 + 다이제스트 최상단",
  mute: "뮤트: 목록에서 숨김 (숨긴 건수만 표시)",
};
const ACTION_STAMP: Record<RuleAction, React.CSSProperties> = {
  alert: { color: "var(--red)", borderColor: "var(--red)" },
  emphasize: { color: "var(--amber)", borderColor: "var(--amber)" },
  mute: { color: "var(--ink-2)", borderColor: "var(--ink-2)" },
};
const GROUP_ORDER: { action: RuleAction; label: string }[] = [
  { action: "alert", label: "알림" },
  { action: "emphasize", label: "강조" },
  { action: "mute", label: "뮤트" },
];

interface Draft {
  id: string | null;
  name: string;
  keywords: string[];
  exclude: string[];
  scope: RuleScopeType;
  scopeId: string | null;
  action: RuleAction;
}

const newDraft = (): Draft => ({
  id: null,
  name: "",
  keywords: [],
  exclude: [],
  scope: "all",
  scopeId: null,
  action: "emphasize",
});

export default function KeywordsPage() {
  const router = useRouter();
  const appRef = useRef<HTMLDivElement>(null);
  useResizable(appRef, "myportal-resize-keywords", {
    panes: [{ default: 340, min: 260, max: 560 }, { min: 640 }],
    flexIndex: 1,
  });

  const [rules, setRules] = useState<KeywordRule[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [draft, setDraft] = useState<Draft>(newDraft);
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ count: number; items: Item[] } | null>(
    null,
  );
  const [kwInput, setKwInput] = useState("");
  const [exInput, setExInput] = useState("");

  const load = useCallback(() => {
    Promise.all([
      api.keywordRules.list(),
      api.categories.list(),
      api.tags.list(),
    ])
      .then(([r, c, t]) => {
        setRules(r);
        setCategories(c);
        setTags(t);
        setDraft((d) => {
          if (d.id || r.length === 0) return d;
          const first = r[0];
          setSelectedRuleId(first.id);
          return { ...first };
        });
      })
      .catch((err) => {
        if (isAuthError(err)) router.replace("/login");
      });
  }, [router]);

  useEffect(load, [load]);

  // 매칭 미리보기 — 입력 변경 시 debounce
  useEffect(() => {
    if (!draft.keywords.length) {
      setPreview(null);
      return;
    }
    const t = setTimeout(() => {
      api.keywordRules
        .preview({
          keywords: draft.keywords,
          exclude: draft.exclude,
          scope: draft.scope,
          scopeId: draft.scopeId,
        })
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 300);
    return () => clearTimeout(t);
  }, [draft.keywords, draft.exclude, draft.scope, draft.scopeId]);

  const categoriesById = useMemo(
    () => new Map(categories.map((c) => [c.id, c])),
    [categories],
  );
  const categoryPath = useCallback(
    (id: string | null): string => {
      if (!id) return "";
      const c = categoriesById.get(id);
      if (!c) return "";
      return c.parentId ? `${categoryPath(c.parentId)} > ${c.name}` : c.name;
    },
    [categoriesById],
  );

  const scopeLabel = useCallback(
    (scope: RuleScopeType, scopeId: string | null): string => {
      if (scope === "category")
        return categoryPath(scopeId) || "카테고리";
      if (scope === "tag") {
        const t = tags.find((x) => x.id === scopeId);
        return `#${t ? t.name : scopeId}`;
      }
      return "전체";
    },
    [categoryPath, tags],
  );

  const apiError = (err: unknown) =>
    showToast(err instanceof ApiError ? err.message : "작업 실패");

  function addChip(field: "keywords" | "exclude", value: string) {
    const v = value.trim();
    if (!v) return;
    setDraft((d) =>
      d[field].includes(v) ? d : { ...d, [field]: [...d[field], v] },
    );
  }

  function chipKeyDown(
    e: React.KeyboardEvent<HTMLInputElement>,
    field: "keywords" | "exclude",
    input: string,
    setInput: (v: string) => void,
  ) {
    if (e.key === "Enter") {
      e.preventDefault();
      addChip(field, input);
      setInput("");
    } else if (e.key === "Backspace" && !input && draft[field].length) {
      setDraft((d) => ({ ...d, [field]: d[field].slice(0, -1) }));
    }
  }

  async function saveRule() {
    if (!draft.name.trim()) return showToast("규칙 이름을 입력하세요");
    if (!draft.keywords.length)
      return showToast("키워드를 1개 이상 입력하세요");
    const body = {
      name: draft.name.trim(),
      keywords: draft.keywords,
      exclude: draft.exclude,
      scope: draft.scope,
      scopeId: draft.scope === "all" ? null : draft.scopeId,
      action: draft.action,
    };
    try {
      const saved = draft.id
        ? await api.keywordRules.update(draft.id, body)
        : await api.keywordRules.create(body);
      showToast("규칙을 저장했습니다");
      setSelectedRuleId(saved.id);
      setDraft({ ...saved });
      load();
    } catch (err) {
      apiError(err);
    }
  }

  async function deleteRule() {
    if (!draft.id) return;
    try {
      await api.keywordRules.remove(draft.id);
      showToast("규칙을 삭제했습니다");
      setSelectedRuleId(null);
      setDraft(newDraft());
      load();
    } catch (err) {
      apiError(err);
    }
  }

  function highlight(title: string): React.ReactNode {
    let parts: (string | React.JSX.Element)[] = [title];
    draft.keywords.forEach((kw, ki) => {
      if (!kw) return;
      const re = new RegExp(
        `(${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`,
        "gi",
      );
      const next: (string | React.JSX.Element)[] = [];
      parts.forEach((p) => {
        if (typeof p !== "string") {
          next.push(p);
          return;
        }
        p.split(re).forEach((seg, i) => {
          if (i % 2 === 1) {
            next.push(
              <mark
                key={`${ki}-${i}-${seg}`}
                style={{
                  background: "transparent",
                  color: "var(--amber)",
                  fontWeight: 700,
                }}
              >
                {seg}
              </mark>,
            );
          } else if (seg) {
            next.push(seg);
          }
        });
      });
      parts = next;
    });
    return parts;
  }

  const fieldLabel: React.CSSProperties = {
    fontSize: 11,
    letterSpacing: "0.03em",
    color: "var(--ink-2)",
    marginBottom: 4,
    marginTop: 16,
  };

  return (
    <div>
      <Masthead />
      <div
        ref={appRef}
        style={{
          display: "grid",
          gridTemplateColumns: "var(--pane-0-width, 340px) minmax(640px, 1fr)",
          height: "calc(100vh - 44px)",
        }}
      >
        {/* 좌측: 규칙 목록 */}
        <aside
          className="bg-paper-2"
          style={{ borderRight: "1px solid var(--rule)", overflowY: "auto" }}
        >
          <div className="p-3">
            <div className="flex items-center justify-between">
              <h1 style={{ fontSize: 18, fontWeight: 700 }}>키워드 규칙</h1>
              <button
                className="btn btn-sm"
                onClick={() => {
                  setSelectedRuleId(null);
                  setDraft(newDraft());
                }}
              >
                새 규칙
              </button>
            </div>
            {GROUP_ORDER.map((g) => {
              const groupRules = rules.filter((r) => r.action === g.action);
              return (
                <div key={g.action}>
                  <div
                    className="text-ink-2"
                    style={{
                      fontSize: 10,
                      letterSpacing: "0.04em",
                      marginBottom: 6,
                      marginTop: 14,
                    }}
                  >
                    {g.label} ({groupRules.length})
                  </div>
                  {!groupRules.length && (
                    <div className="text-ink-2" style={{ fontSize: 12, padding: "4px 2px" }}>
                      규칙 없음
                    </div>
                  )}
                  {groupRules.map((r) => (
                    <div
                      key={r.id}
                      className="cursor-pointer"
                      style={{
                        border:
                          r.id === selectedRuleId
                            ? "1px solid var(--ink)"
                            : "1px solid transparent",
                        borderBottom: "1px solid var(--rule)",
                        padding: "8px 10px",
                        background:
                          r.id === selectedRuleId ? "var(--paper)" : undefined,
                      }}
                      onClick={() => {
                        setSelectedRuleId(r.id);
                        setDraft({ ...r });
                      }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="stamp" style={ACTION_STAMP[r.action]}>
                          {ACTION_LABELS[r.action]}
                        </span>
                      </div>
                      <div className="mt-1" style={{ fontSize: 13, fontWeight: 500 }}>
                        {r.name}
                      </div>
                      <div className="font-mono text-ink-2 mt-1" style={{ fontSize: 11 }}>
                        {r.keywords.join(" / ") || "(키워드 없음)"}
                      </div>
                      <div className="text-ink-2 mt-1" style={{ fontSize: 11 }}>
                        {scopeLabel(r.scope, r.scopeId)}
                      </div>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </aside>

        {/* 우측: 편집기 */}
        <main style={{ overflowY: "auto" }}>
          <div className="px-6 pt-5 pb-10" style={{ maxWidth: 760 }}>
            <div className="rule-double">
              <h2 style={{ fontSize: 20, fontWeight: 700 }}>
                {draft.id ? "규칙 편집" : "새 규칙"}
              </h2>
            </div>

            <div style={{ ...fieldLabel, marginTop: 0 }}>규칙 이름</div>
            <input
              className="input-line"
              type="text"
              placeholder="예: 휴머노이드"
              value={draft.name}
              onChange={(e) =>
                setDraft((d) => ({ ...d, name: e.target.value }))
              }
            />

            <div style={fieldLabel}>
              키워드 (여러 개, OR 조건 · Enter로 추가)
            </div>
            <div
              className="chip-input-row"
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                borderBottom: "1px solid var(--ink-2)",
                padding: "4px 2px",
                minHeight: 34,
              }}
            >
              {draft.keywords.map((kw, i) => (
                <span
                  key={`${kw}-${i}`}
                  className="font-mono inline-flex items-center gap-1"
                  style={{
                    fontSize: 11,
                    border: "1px solid var(--ink-2)",
                    padding: "2px 6px",
                    margin: "2px 6px 2px 0",
                  }}
                >
                  {kw}
                  <button
                    type="button"
                    style={{
                      background: "none",
                      border: "none",
                      color: "var(--ink-2)",
                      cursor: "pointer",
                      fontSize: 12,
                      padding: 0,
                    }}
                    onClick={() =>
                      setDraft((d) => ({
                        ...d,
                        keywords: d.keywords.filter((_, j) => j !== i),
                      }))
                    }
                  >
                    ×
                  </button>
                </span>
              ))}
              <input
                type="text"
                placeholder="키워드 입력 후 Enter"
                style={{
                  border: "none",
                  background: "transparent",
                  outline: "none",
                  fontSize: 13,
                  flex: 1,
                  minWidth: 140,
                  padding: "4px 2px",
                  color: "var(--ink)",
                }}
                value={kwInput}
                onChange={(e) => setKwInput(e.target.value)}
                onKeyDown={(e) =>
                  chipKeyDown(e, "keywords", kwInput, setKwInput)
                }
              />
            </div>

            <div style={fieldLabel}>제외어</div>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                borderBottom: "1px solid var(--ink-2)",
                padding: "4px 2px",
                minHeight: 34,
              }}
            >
              {draft.exclude.map((ex, i) => (
                <span
                  key={`${ex}-${i}`}
                  className="font-mono inline-flex items-center gap-1"
                  style={{
                    fontSize: 11,
                    border: "1px solid var(--ink-2)",
                    padding: "2px 6px",
                    margin: "2px 6px 2px 0",
                  }}
                >
                  {ex}
                  <button
                    type="button"
                    style={{
                      background: "none",
                      border: "none",
                      color: "var(--ink-2)",
                      cursor: "pointer",
                      fontSize: 12,
                      padding: 0,
                    }}
                    onClick={() =>
                      setDraft((d) => ({
                        ...d,
                        exclude: d.exclude.filter((_, j) => j !== i),
                      }))
                    }
                  >
                    ×
                  </button>
                </span>
              ))}
              <input
                type="text"
                placeholder="제외어 입력 후 Enter"
                style={{
                  border: "none",
                  background: "transparent",
                  outline: "none",
                  fontSize: 13,
                  flex: 1,
                  minWidth: 140,
                  padding: "4px 2px",
                  color: "var(--ink)",
                }}
                value={exInput}
                onChange={(e) => setExInput(e.target.value)}
                onKeyDown={(e) => chipKeyDown(e, "exclude", exInput, setExInput)}
              />
            </div>

            <div style={fieldLabel}>적용 범위</div>
            <div className="flex items-center gap-3 flex-wrap">
              <select
                className="input-line"
                style={{ width: "auto", padding: "6px 8px" }}
                value={draft.scope}
                onChange={(e) => {
                  const scope = e.target.value as RuleScopeType;
                  setDraft((d) => ({
                    ...d,
                    scope,
                    scopeId:
                      scope === "all"
                        ? null
                        : scope === "category"
                          ? (categories[0]?.id ?? null)
                          : (tags[0]?.id ?? null),
                  }));
                }}
              >
                <option value="all">전체</option>
                <option value="category">카테고리</option>
                <option value="tag">태그</option>
              </select>
              {draft.scope === "category" && (
                <select
                  className="input-line"
                  style={{ width: "auto", minWidth: 220, padding: "6px 8px" }}
                  value={draft.scopeId ?? ""}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, scopeId: e.target.value }))
                  }
                >
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {categoryPath(c.id)}
                    </option>
                  ))}
                </select>
              )}
              {draft.scope === "tag" && (
                <select
                  className="input-line"
                  style={{ width: "auto", minWidth: 160, padding: "6px 8px" }}
                  value={draft.scopeId ?? ""}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, scopeId: e.target.value }))
                  }
                >
                  {tags.map((t) => (
                    <option key={t.id} value={t.id}>
                      #{t.name}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div style={fieldLabel}>동작</div>
            {ACTION_ORDER.map((a) => (
              <label
                key={a}
                className="cursor-pointer block"
                style={{
                  border: `1px solid ${draft.action === a ? "var(--ink)" : "var(--rule)"}`,
                  background:
                    draft.action === a ? "var(--paper-2)" : undefined,
                  padding: "8px 10px",
                  marginBottom: 6,
                }}
              >
                <input
                  type="radio"
                  name="rule-action"
                  value={a}
                  checked={draft.action === a}
                  onChange={() => setDraft((d) => ({ ...d, action: a }))}
                  style={{ marginRight: 8 }}
                />
                <span style={{ fontSize: 13 }}>{ACTION_DESC[a]}</span>
              </label>
            ))}

            <p className="text-ink-2 mt-3" style={{ fontSize: 11, lineHeight: 1.6 }}>
              매칭 규칙: 대소문자·전각/반각 차이를 무시하고, 조사가 붙은 형태도
              걸리도록 부분 일치를 기본으로 합니다. 규칙은 새 항목 수집 시
              백엔드에서 판정되어 저장되며, 저장 시 최근 항목에도 재적용됩니다.
            </p>

            <div className="flex items-center gap-2 mt-5">
              <button className="btn btn-primary" onClick={() => void saveRule()}>
                규칙 저장
              </button>
              <button
                className="btn"
                disabled={!draft.id}
                onClick={() => void deleteRule()}
              >
                삭제
              </button>
            </div>

            <div style={{ marginTop: 28 }}>
              <div className="rule-double">
                <h3 style={{ fontSize: 16, fontWeight: 700 }}>매칭 미리보기</h3>
              </div>
              <div className="font-mono text-ink-2 mt-2" style={{ fontSize: 12 }}>
                {draft.keywords.length
                  ? preview
                    ? `${preview.count}건 일치`
                    : "계산 중…"
                  : ""}
              </div>
              <div className="mt-2">
                {draft.keywords.length === 0 && (
                  <div className="text-ink-2 py-3" style={{ fontSize: 12 }}>
                    일치하는 항목이 없습니다. 키워드를 입력하면 즉시 반영됩니다.
                  </div>
                )}
                {preview?.items.slice(0, 30).map((it) => (
                  <div
                    key={it.id}
                    style={{ borderBottom: "1px solid var(--rule)", padding: "6px 0" }}
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span style={{ fontSize: 13 }}>
                        {highlight(it.title)}
                      </span>
                      <span
                        className="font-mono text-ink-2 shrink-0"
                        style={{ fontSize: 11 }}
                      >
                        {it.collectedAt.slice(5, 10).replace("-", ".")}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
