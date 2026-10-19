"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  AnalyzeResult,
  Category,
  SourceField,
  FieldType,
  FieldRole,
} from "@myportal/api-contracts";
import { api, isAuthError, ApiError } from "@/lib/api";
import { pad2, showToast } from "@/lib/shell";
import { Masthead } from "@/components/masthead";

const EXAMPLES = [
  { url: "https://www.iitp.kr/kr/1/notice/list.it", name: "IITP 사업공고" },
  { url: "https://www.k-startup.go.kr/notice/list", name: "K-Startup 공고" },
  {
    url: "https://techcrunch.com/category/artificial-intelligence/",
    name: "TechCrunch AI",
  },
];

const ROLE_OPTIONS: { value: FieldRole; label: string }[] = [
  { value: "none", label: "없음" },
  { value: "title", label: "제목" },
  { value: "link", label: "링크" },
  { value: "published", label: "게시일" },
  { value: "deadline", label: "마감일" },
  { value: "summary", label: "요약" },
];

const TYPE_OPTIONS: { value: FieldType; label: string }[] = [
  { value: "text", label: "텍스트" },
  { value: "url", label: "URL" },
  { value: "date", label: "날짜" },
  { value: "datetime", label: "일시" },
  { value: "date_range", label: "기간" },
  { value: "number", label: "숫자" },
  { value: "image", label: "이미지" },
  { value: "tag_list", label: "태그 목록" },
];

interface LogLine {
  time: string;
  label: string;
  status: string;
  detail: string | null;
}

const STAMP_FOR: Record<string, string> = {
  ok: "stamp stamp-ok",
  warn: "stamp stamp-warn",
  fail: "stamp stamp-fail",
  pause: "stamp stamp-pause",
  running: "stamp stamp-pause",
};

export default function AddSourcePage() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [hint, setHint] = useState("");
  const [log, setLog] = useState<LogLine[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [fields, setFields] = useState<SourceField[]>([]);
  const [displayName, setDisplayName] = useState("");
  const [categoryId, setCategoryId] = useState<string>("");
  const [tags, setTags] = useState<string[]>([]);
  const [newTag, setNewTag] = useState("");
  const [candidate, setCandidate] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [pageTextFilter, setPageTextFilter] = useState("");

  useEffect(() => {
    api.categories
      .list()
      .then(setCategories)
      .catch((err) => {
        if (isAuthError(err)) router.replace("/login");
      });
  }, [router]);

  const categoriesById = useMemo(() => {
    const m = new Map(categories.map((c) => [c.id, c]));
    return m;
  }, [categories]);

  const categoryPath = useCallback(
    (id: string): string => {
      const c = categoriesById.get(id);
      if (!c) return "";
      return c.parentId ? `${categoryPath(c.parentId)} › ${c.name}` : c.name;
    },
    [categoriesById],
  );

  const logTime = useCallback((): string => {
    const t = new Date();
    return `${pad2(t.getHours())}:${pad2(t.getMinutes())}:${pad2(t.getSeconds())}`;
  }, []);

  async function analyze(targetUrl: string) {
    setAnalyzing(true);
    setResult(null);
    setSaved(null);
    setLog([{ time: logTime(), label: "분석 시작", status: "running", detail: targetUrl }]);
    try {
      const res = await api.sources.analyze({
        url: targetUrl,
        hint: hint.trim() || undefined,
      });
      setResult(res);
      setLog(res.steps.map((s) => ({ time: logTime(), ...s })));
      if (res.outcome === "list" && res.preview) {
        setFields(res.preview.fields);
        setDisplayName(res.suggested.displayName || res.pageTitle || "");
        setTags(res.suggested.tagNames);
        if (res.suggested.categoryPath.length) {
          const leaf = res.suggested.categoryPath.at(-1);
          const found = categories.find((c) => c.name === leaf);
          if (found) setCategoryId(found.id);
        }
      }
      if (res.outcome === "exists") {
        showToast("이미 등록된 소스입니다");
      }
    } catch (err) {
      const msg =
        err instanceof ApiError ? `${err.message} (${err.code})` : "분석 실패";
      setLog((l) => [
        ...l,
        { time: logTime(), label: "분석 오류", status: "fail", detail: msg },
      ]);
    } finally {
      setAnalyzing(false);
    }
  }

  function fieldRowValue(row: Record<string, unknown>, key: string): string {
    const v = row[key];
    if (v === undefined || v === null) return "";
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  }

  async function save(linkOnly = false) {
    if (!result?.normalizedUrl && !url.trim()) return;
    setSaving(true);
    try {
      const res = await api.sources.create({
        url: result?.normalizedUrl ?? url.trim(),
        displayName: displayName || result?.pageTitle || url.trim(),
        categoryId: categoryId || null,
        tagNames: tags,
        fields: linkOnly
          ? fields.length
            ? fields
            : [
                {
                  key: "title",
                  label: "제목",
                  type: "text",
                  role: "title" as const,
                  visible: true,
                  sortOrder: 0,
                },
              ]
          : fields,
        fetchStrategy: linkOnly
          ? "link"
          : (result?.preview?.fetchStrategy ?? "html"),
        linkOnly,
        // 분석 시 확정된 스펙/미리보기를 그대로 전달해 저장 시 재추출을 방지한다.
        spec: result?.preview?.spec ?? null,
        previewRows: result?.preview?.rows,
      });
      setSaved(res.subscriptionId);
      showToast(
        linkOnly
          ? "링크 전용 소스로 저장되었습니다. 수집하지 않습니다."
          : `소스를 등록했습니다. 기준선 ${res.baselineCount}건 수집됨`,
      );
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "저장 실패");
    } finally {
      setSaving(false);
    }
  }

  const previewRows = result?.preview?.rows ?? [];

  // 힌트를 입력했는데 마지막 '힌트 영역 선택' 단계가 실패(warn)로 끝났으면
  // 수집된 페이지 텍스트를 우측에 보여 사용자가 직접 힌트를 고르게 한다.
  const hintMissed =
    (result?.steps ?? [])
      .filter((s) => s.label === "힌트 영역 선택")
      .at(-1)?.status === "warn";
  const pageTextLines = (result?.pageText ?? "").split("\n").filter(Boolean);
  const pq = pageTextFilter.trim().toLowerCase();
  const filteredPageLines = pq
    ? pageTextLines.filter((l) => l.toLowerCase().includes(pq))
    : pageTextLines;

  return (
    <div>
      <Masthead />
      <div className="px-6 py-5" style={{ maxWidth: 1560, margin: "0 auto" }}>
        <h1 style={{ fontSize: 20, fontWeight: 700 }}>소스 등록</h1>
        <div className="rule-double" style={{ marginTop: 4, marginBottom: 16 }} />

        <div
          className="grid gap-6"
          style={{ gridTemplateColumns: "460px minmax(0,1fr)" }}
        >
          {/* 좌측: URL + 로그 */}
          <div>
            <label
              className="font-mono text-ink-2"
              style={{ display: "block", marginBottom: 2, fontSize: 11 }}
            >
              소스 URL
            </label>
            <input
              className="input-line font-mono"
              style={{ fontSize: 13 }}
              placeholder="https://example.go.kr/notice/list"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <div className="mt-2" style={{ fontSize: 11 }}>
              {EXAMPLES.map((e, i) => (
                <span key={e.url}>
                  {i > 0 && (
                    <span className="font-mono text-ink-2"> · </span>
                  )}
                  <button
                    type="button"
                    className="font-mono text-blue underline"
                    style={{ fontSize: 11, background: "none", border: "none", cursor: "pointer", padding: 0 }}
                    onClick={() => {
                      setUrl(e.url);
                      setDisplayName(e.name);
                    }}
                  >
                    {e.url}
                  </button>
                </span>
              ))}
            </div>

            <label
              className="font-mono text-ink-2"
              style={{ display: "block", marginTop: 14, marginBottom: 2, fontSize: 11 }}
            >
              목록 항목 힌트 (선택)
            </label>
            <input
              className="input-line"
              style={{ fontSize: 13 }}
              placeholder="목록에 표시되는 항목 텍스트 일부 — 예: 2026 한국외식산업연구원 외식경영스타 아이디어 공모전"
              value={hint}
              onChange={(e) => setHint(e.target.value)}
            />
            <div className="font-mono text-ink-2" style={{ fontSize: 11, marginTop: 2 }}>
              자동 분석이 메뉴 등 엉뚱한 영역을 잡을 때, 실제 목록 항목의 텍스트를
              붙여넣으면 그 영역을 기준으로 추출합니다.
            </div>

            <div className="mt-3 flex items-center gap-3">
              <button
                className="btn btn-primary"
                disabled={analyzing || !url.trim()}
                onClick={() => void analyze(url.trim())}
              >
                {analyzing ? "분석 중…" : "분석 시작"}
              </button>
            </div>

            <div className="mt-4">
              <div
                className="font-mono text-ink-2"
                style={{ marginBottom: 4, fontSize: 11, letterSpacing: "0.03em" }}
              >
                분석 전보 로그
              </div>
              <div
                className="font-mono"
                style={{
                  background: "var(--paper-2)",
                  border: "1px solid var(--rule)",
                  height: 260,
                  overflowY: "auto",
                  padding: "10px 12px",
                  fontSize: 12,
                }}
              >
                {log.length === 0 && (
                  <div className="text-ink-2" style={{ fontSize: 11 }}>
                    URL을 입력하고 분석 시작을 누르면 단계별 로그가 여기
                    표시됩니다.
                  </div>
                )}
                {log.map((l, i) => (
                  <div
                    key={i}
                    className="flex items-baseline justify-between"
                    style={{
                      gap: 10,
                      padding: "2px 0",
                      borderBottom:
                        i < log.length - 1
                          ? "1px dotted var(--rule)"
                          : undefined,
                    }}
                  >
                    <span>
                      {l.time} {l.label}
                      {l.detail ? ` — ${l.detail}` : ""}
                    </span>
                    <span className={STAMP_FOR[l.status] ?? "stamp"}>
                      {l.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* 부모 목록 후보 */}
            {result?.outcome === "detail" && result.candidates.length > 0 && (
              <div className="mt-4">
                <div
                  className="font-mono text-ink-2"
                  style={{ marginBottom: 6, fontSize: 11, letterSpacing: "0.03em" }}
                >
                  부모 목록 후보
                </div>
                {result.candidates.map((c, i) => (
                  <label
                    key={i}
                    className="flex items-start gap-2 cursor-pointer"
                    style={{
                      border: "1px solid var(--rule)",
                      padding: "8px 10px",
                      marginBottom: 6,
                    }}
                  >
                    <input
                      type="radio"
                      name="candidate"
                      value={c.url}
                      checked={candidate === c.url}
                      onChange={() => setCandidate(c.url)}
                      style={{ marginTop: 3 }}
                    />
                    <span style={{ fontSize: 13 }}>
                      <div>{c.label}</div>
                      <div className="font-mono text-ink-2" style={{ fontSize: 11 }}>
                        {c.url}
                      </div>
                    </span>
                  </label>
                ))}
                <label
                  className="flex items-start gap-2 cursor-pointer"
                  style={{
                    border: "1px solid var(--rule)",
                    padding: "8px 10px",
                    marginBottom: 6,
                  }}
                >
                  <input
                    type="radio"
                    name="candidate"
                    value="__none__"
                    checked={candidate === "__none__"}
                    onChange={() => setCandidate("__none__")}
                    style={{ marginTop: 3 }}
                  />
                  <span style={{ fontSize: 13 }}>
                    <div>링크 전용으로 보관</div>
                    <div className="font-mono text-ink-2" style={{ fontSize: 11 }}>
                      부모 목록을 찾지 못했거나 이 URL만 링크로 저장합니다.
                      수집하지 않습니다.
                    </div>
                  </span>
                </label>
                <button
                  className="btn mt-2"
                  disabled={!candidate}
                  onClick={() => {
                    if (candidate === "__none__") void save(true);
                    else if (candidate) {
                      setUrl(candidate);
                      void analyze(candidate);
                    }
                  }}
                >
                  선택한 후보로 계속
                </button>
              </div>
            )}

            {result?.outcome === "link-only" && (
              <div className="mt-4">
                <div className="font-mono text-ink-2" style={{ fontSize: 11 }}>
                  robots.txt가 수집을 금지합니다. 링크 전용으로만 보관할 수
                  있습니다.
                </div>
                <button
                  className="btn mt-2"
                  disabled={saving}
                  onClick={() => void save(true)}
                >
                  링크 전용으로 저장
                </button>
              </div>
            )}
          </div>

          {/* 우측 열: 페이지 텍스트(힌트 미스 시) + 추출 미리보기 */}
          <div>
          {/* 우측: 페이지 텍스트 (힌트 미스 시 수동 힌트 선택용) */}
          {hintMissed && result?.pageText && (
            <div>
              <div className="flex items-baseline justify-between">
                <div style={{ fontSize: 15, fontWeight: 700 }}>
                  수집된 페이지 텍스트
                </div>
                <div className="font-mono text-ink-2" style={{ fontSize: 11 }}>
                  {pageTextLines.length}줄
                </div>
              </div>
              <div
                className="font-mono text-ink-2"
                style={{ fontSize: 11, marginTop: 4 }}
              >
                힌트 영역을 찾지 못했습니다. 아래에서 실제 목록 항목의 텍스트를
                복사해 ‘목록 항목 힌트’에 붙여넣고 다시 분석하세요.
              </div>
              <input
                className="input-line mt-2"
                style={{ fontSize: 12 }}
                placeholder="텍스트 필터 — 입력한 문자열을 포함한 줄만 표시"
                value={pageTextFilter}
                onChange={(e) => setPageTextFilter(e.target.value)}
              />
              <pre
                className="font-mono mt-2"
                style={{
                  background: "var(--paper-2)",
                  border: "1px solid var(--rule)",
                  height: 480,
                  overflowY: "auto",
                  padding: "10px 12px",
                  fontSize: 11,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                }}
              >
                {filteredPageLines.join("\n")}
              </pre>
            </div>
          )}

          {/* 우측: 추출 미리보기 */}
          {result?.outcome === "list" && result.preview && (
            <div>
              <div className="flex items-baseline justify-between">
                <div style={{ fontSize: 15, fontWeight: 700 }}>
                  추출 미리보기
                </div>
                <div className="font-mono text-ink-2" style={{ fontSize: 11 }}>
                  최근 {previewRows.length}건 · 필드 {fields.length}개 ·{" "}
                  {result.preview.fetchStrategy}
                </div>
              </div>
              <div className="mt-2" style={{ overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", width: "100%" }}>
                  <thead>
                    <tr>
                      {fields.map((f, idx) => (
                        <th
                          key={f.key}
                          style={{
                            border: "1px solid var(--rule)",
                            padding: "6px 8px",
                            verticalAlign: "top",
                            minWidth: 150,
                            opacity: f.visible ? 1 : 0.4,
                            textAlign: "left",
                          }}
                        >
                          <input
                            className="input-line"
                            style={{ fontSize: 11 }}
                            value={f.label}
                            onChange={(e) =>
                              setFields((fs) =>
                                fs.map((x, i) =>
                                  i === idx
                                    ? { ...x, label: e.target.value }
                                    : x,
                                ),
                              )
                            }
                          />
                          <select
                            className="input-line mt-1"
                            style={{ fontSize: 11 }}
                            value={f.type}
                            onChange={(e) =>
                              setFields((fs) =>
                                fs.map((x, i) =>
                                  i === idx
                                    ? {
                                        ...x,
                                        type: e.target.value as FieldType,
                                      }
                                    : x,
                                ),
                              )
                            }
                          >
                            {TYPE_OPTIONS.map((t) => (
                              <option key={t.value} value={t.value}>
                                {t.label}
                              </option>
                            ))}
                          </select>
                          <select
                            className="input-line mt-1"
                            style={{ fontSize: 11 }}
                            value={f.role}
                            onChange={(e) =>
                              setFields((fs) =>
                                fs.map((x, i) =>
                                  i === idx
                                    ? {
                                        ...x,
                                        role: e.target.value as FieldRole,
                                      }
                                    : x,
                                ),
                              )
                            }
                          >
                            {ROLE_OPTIONS.map((r) => (
                              <option key={r.value} value={r.value}>
                                {r.label}
                              </option>
                            ))}
                          </select>
                          <label
                            className="font-mono text-ink-2 flex items-center gap-1 mt-1"
                            style={{ fontSize: 11 }}
                          >
                            <input
                              type="checkbox"
                              checked={!f.visible}
                              onChange={(e) =>
                                setFields((fs) =>
                                  fs.map((x, i) =>
                                    i === idx
                                      ? { ...x, visible: !e.target.checked }
                                      : x,
                                  ),
                                )
                              }
                            />
                            숨김
                          </label>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.map((row, ri) => (
                      <tr key={ri}>
                        {fields.map((f) => {
                          const mono =
                            f.type === "date" ||
                            f.type === "datetime" ||
                            f.type === "date_range" ||
                            f.type === "number" ||
                            f.type === "url";
                          return (
                            <td
                              key={f.key}
                              className={mono ? "font-mono" : ""}
                              style={{
                                border: "1px solid var(--rule)",
                                padding: "5px 8px",
                                fontSize: mono ? 11 : 12,
                                verticalAlign: "top",
                                opacity: f.visible ? 1 : 0.4,
                              }}
                            >
                              {fieldRowValue(row, f.key)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div
                className="mt-5 grid gap-5"
                style={{ gridTemplateColumns: "1fr 1fr" }}
              >
                <div>
                  <label
                    className="font-mono text-ink-2"
                    style={{ display: "block", marginBottom: 2, fontSize: 11 }}
                  >
                    제안 카테고리
                  </label>
                  <select
                    className="input-line"
                    style={{ fontSize: 13 }}
                    value={categoryId}
                    onChange={(e) => setCategoryId(e.target.value)}
                  >
                    <option value="">(미분류)</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {categoryPath(c.id)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label
                    className="font-mono text-ink-2"
                    style={{ display: "block", marginBottom: 2, fontSize: 11 }}
                  >
                    표시 이름
                  </label>
                  <input
                    className="input-line"
                    style={{ fontSize: 13 }}
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                  />
                </div>
              </div>

              <div className="mt-4">
                <label
                  className="font-mono text-ink-2"
                  style={{ display: "block", marginBottom: 4, fontSize: 11 }}
                >
                  제안 태그
                </label>
                <div>
                  {tags.map((t, i) => (
                    <span
                      key={`${t}-${i}`}
                      className="font-mono text-ink-2 inline-flex items-center"
                      style={{
                        fontSize: 11,
                        border: "1px solid var(--ink-2)",
                        padding: "1px 4px 1px 7px",
                        margin: "0 4px 4px 0",
                      }}
                    >
                      #{t}
                      <button
                        type="button"
                        style={{
                          border: "none",
                          background: "none",
                          color: "var(--ink-2)",
                          cursor: "pointer",
                          fontSize: 11,
                          padding: "0 2px",
                        }}
                        onClick={() =>
                          setTags((ts) => ts.filter((_, j) => j !== i))
                        }
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <input
                    className="input-line"
                    style={{ fontSize: 12, width: 160 }}
                    placeholder="태그 추가"
                    value={newTag}
                    onChange={(e) => setNewTag(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        const v = newTag.trim();
                        if (v && !tags.includes(v)) setTags([...tags, v]);
                        setNewTag("");
                      }
                    }}
                  />
                  <button
                    className="btn btn-sm"
                    onClick={() => {
                      const v = newTag.trim();
                      if (v && !tags.includes(v)) setTags([...tags, v]);
                      setNewTag("");
                    }}
                  >
                    추가
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-3 mt-5">
                <button
                  className="btn btn-primary"
                  disabled={saving || !!saved}
                  onClick={() => void save(false)}
                >
                  {saving ? "저장 중…" : saved ? "저장됨" : "이 구조로 저장"}
                </button>
                <button
                  className="btn"
                  disabled={analyzing}
                  onClick={() => void analyze(result.normalizedUrl ?? url)}
                >
                  다시 분석
                </button>
              </div>
              {saved && (
                <div
                  className="mt-3 font-mono text-ink-2"
                  style={{ fontSize: 11 }}
                >
                  등록되었습니다. 데스크에서 새 항목이 들어오면 표시됩니다.
                </div>
              )}
            </div>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}
