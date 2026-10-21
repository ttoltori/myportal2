"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Category, Subscription, Tag } from "@myportal/api-contracts";
import { api, isAuthError, ApiError } from "@/lib/api";
import { showToast } from "@/lib/shell";
import { Masthead } from "@/components/masthead";
import { useResizable } from "@/components/desk/use-resizable";

const MAX_DEPTH = 4;

interface ModalState {
  title: string;
  body: React.ReactNode;
}

export default function CategoriesPage() {
  const router = useRouter();
  const [categories, setCategories] = useState<Category[]>([]);
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [subsSelected, setSubsSelected] = useState<Record<string, boolean>>({});
  const [bulkTarget, setBulkTarget] = useState("");
  const [modal, setModal] = useState<ModalState | null>(null);
  const [newTagName, setNewTagName] = useState("");
  const [dropTarget, setDropTarget] = useState<string | "root" | null>(null);

  const [gridEl, setGridEl] = useState<HTMLDivElement | null>(null);
  useResizable(gridEl, "myportal-resize-categories", {
    panes: [{ default: 420, min: 280, max: 640 }, { min: 420 }],
    flexIndex: 1,
  });

  const load = useCallback(() => {
    Promise.all([
      api.categories.list(),
      api.subscriptions.list(),
      api.tags.list(),
    ])
      .then(([c, s, t]) => {
        setCategories(c);
        setSubs(s);
        setTags(t);
        setExpanded((e) => {
          const next = { ...e };
          c.forEach((cat) => {
            if (!(cat.id in next)) next[cat.id] = true;
          });
          return next;
        });
        setSelectedId((sel) => {
          if (sel && c.some((x) => x.id === sel)) return sel;
          const root = c.find((x) => !x.parentId) ?? c[0];
          return root?.id ?? null;
        });
      })
      .catch((err) => {
        if (isAuthError(err)) router.replace("/login");
      });
  }, [router]);

  useEffect(load, [load]);

  const categoriesById = useMemo(
    () => new Map(categories.map((c) => [c.id, c])),
    [categories],
  );

  const childrenOf = useCallback(
    (parentId: string | null) =>
      categories.filter((c) => c.parentId === parentId),
    [categories],
  );

  const depthOf = useCallback(
    (id: string): number => {
      let d = 1;
      let cur = categoriesById.get(id);
      while (cur?.parentId) {
        d += 1;
        cur = categoriesById.get(cur.parentId);
      }
      return d;
    },
    [categoriesById],
  );

  const subtreeHeight = useCallback(
    (id: string): number => {
      const kids = childrenOf(id);
      if (!kids.length) return 1;
      return 1 + Math.max(...kids.map((k) => subtreeHeight(k.id)));
    },
    [childrenOf],
  );

  const isDescendantOrSelf = useCallback(
    (candidateId: string, ofId: string): boolean => {
      let cur = categoriesById.get(candidateId);
      while (cur) {
        if (cur.id === ofId) return true;
        cur = cur.parentId ? categoriesById.get(cur.parentId) : undefined;
      }
      return false;
    },
    [categoriesById],
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

  const directSubCount = useCallback(
    (id: string) => subs.filter((s) => s.categoryId === id).length,
    [subs],
  );

  const apiError = (err: unknown) =>
    showToast(err instanceof ApiError ? err.message : "작업 실패");

  async function moveCategory(movingId: string, targetParentId: string | null) {
    if (movingId === targetParentId) return;
    if (targetParentId !== null && isDescendantOrSelf(targetParentId, movingId)) {
      showToast("이동할 수 없습니다: 하위 카테고리로는 이동할 수 없습니다");
      return;
    }
    const newDepth =
      targetParentId === null ? 1 : depthOf(targetParentId) + 1;
    if (newDepth + subtreeHeight(movingId) - 1 > MAX_DEPTH) {
      showToast("카테고리 깊이 제한(최대 4단계)을 초과합니다");
      return;
    }
    try {
      await api.categories.update(movingId, { parentId: targetParentId });
      showToast(
        `‘${categoriesById.get(movingId)?.name ?? ""}’ 카테고리를 이동했습니다`,
      );
      load();
    } catch (err) {
      apiError(err);
    }
  }

  async function moveSource(subscriptionId: string, targetCategoryId: string) {
    try {
      await api.subscriptions.update(subscriptionId, {
        categoryId: targetCategoryId,
      });
      showToast(`구독을 ‘${categoryPath(targetCategoryId)}’(으)로 이동했습니다`);
      load();
    } catch (err) {
      apiError(err);
    }
  }

  function onDropOnCategory(e: React.DragEvent, catId: string) {
    e.preventDefault();
    setDropTarget(null);
    const data = e.dataTransfer.getData("text/plain");
    if (data.startsWith("category:")) void moveCategory(data.slice(9), catId);
    else if (data.startsWith("source:")) void moveSource(data.slice(7), catId);
  }

  function renderTreeNode(cat: Category, depth: number): React.ReactNode {
    const kids = childrenOf(cat.id);
    const isExp = !!expanded[cat.id];
    return (
      <div key={cat.id}>
        <div
          className="tree-row"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "4px 6px",
            paddingLeft: depth * 14 + 6,
            border: "1px solid transparent",
            cursor: "pointer",
            background:
              cat.id === selectedId ? "var(--paper-2)" : undefined,
            borderColor:
              cat.id === selectedId
                ? "var(--rule)"
                : dropTarget === cat.id
                  ? "var(--blue)"
                  : "transparent",
            outline:
              dropTarget === cat.id ? "2px solid var(--blue)" : undefined,
            outlineOffset: -2,
          }}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData("text/plain", `category:${cat.id}`);
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }}
          onDragEnter={(e) => {
            e.preventDefault();
            setDropTarget(cat.id);
          }}
          onDragLeave={() =>
            setDropTarget((d) => (d === cat.id ? null : d))
          }
          onDrop={(e) => onDropOnCategory(e, cat.id)}
          onClick={() => {
            setSelectedId(cat.id);
            setSubsSelected({});
          }}
        >
          <span className="flex items-center min-w-0">
            <span
              className="font-mono text-ink-2 select-none"
              style={{ padding: "0 4px", cursor: "grab" }}
              title="드래그로 이동"
            >
              ⋮⋮
            </span>
            {kids.length > 0 ? (
              <span
                className="font-mono text-ink-2 select-none cursor-pointer"
                style={{ width: 12, textAlign: "center" }}
                onClick={(e) => {
                  e.stopPropagation();
                  setExpanded((x) => ({ ...x, [cat.id]: !x[cat.id] }));
                }}
              >
                {isExp ? "▾" : "▸"}
              </span>
            ) : (
              <span style={{ width: 12, display: "inline-block" }} />
            )}
            <span className="truncate" style={{ fontSize: 13 }}>
              {cat.name}
            </span>
          </span>
          <span className="font-mono text-ink-2" style={{ fontSize: 11 }}>
            {directSubCount(cat.id)}
          </span>
        </div>
        {kids.length > 0 &&
          isExp &&
          kids.map((k) => renderTreeNode(k, depth + 1))}
      </div>
    );
  }

  // ---------- modals ----------
  function inputModal(
    title: string,
    initial: string,
    buttonLabel: string,
    onConfirm: (name: string) => void,
  ) {
    const ModalBody = () => {
      const [v, setV] = useState(initial);
      return (
        <div>
          <input
            className="input-line mb-3"
            style={{ fontSize: 13 }}
            value={v}
            autoFocus
            onChange={(e) => setV(e.target.value)}
          />
          <button
            className="btn btn-primary btn-sm"
            onClick={() => {
              const name = v.trim();
              if (!name) return showToast("이름을 입력하세요");
              onConfirm(name);
            }}
          >
            {buttonLabel}
          </button>
        </div>
      );
    };
    setModal({ title, body: <ModalBody /> });
  }

  function openCreateModal() {
    const ModalBody = () => {
      const [parent, setParent] = useState("");
      const [name, setName] = useState("");
      return (
        <div>
          <label className="text-ink-2 block mb-1" style={{ fontSize: 11 }}>
            상위 카테고리
          </label>
          <select
            className="input-line mb-3"
            style={{ fontSize: 13 }}
            value={parent}
            onChange={(e) => setParent(e.target.value)}
          >
            <option value="">(최상위)</option>
            {categories
              .filter((c) => depthOf(c.id) < MAX_DEPTH)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {categoryPath(c.id)}
                </option>
              ))}
          </select>
          <label className="text-ink-2 block mb-1" style={{ fontSize: 11 }}>
            이름
          </label>
          <input
            className="input-line mb-3"
            style={{ fontSize: 13 }}
            placeholder="카테고리 이름"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
          <button
            className="btn btn-primary btn-sm"
            onClick={async () => {
              const n = name.trim();
              if (!n) return showToast("이름을 입력하세요");
              try {
                const c = await api.categories.create({
                  name: n,
                  parentId: parent || null,
                });
                setModal(null);
                showToast(`‘${n}’ 카테고리를 만들었습니다`);
                setSelectedId(c.id);
                if (parent) setExpanded((x) => ({ ...x, [parent]: true }));
                load();
              } catch (err) {
                apiError(err);
              }
            }}
          >
            만들기
          </button>
        </div>
      );
    };
    setModal({ title: "새 카테고리", body: <ModalBody /> });
  }

  function openDeleteModal() {
    const cat = selectedId ? categoriesById.get(selectedId) : null;
    if (!cat) return showToast("카테고리를 선택하세요");
    const kidCount = childrenOf(cat.id).length;
    const subCount = directSubCount(cat.id);
    const parentLabel = cat.parentId ? categoryPath(cat.parentId) : "최상위";
    setModal({
      title: "카테고리 삭제",
      body: (
        <div>
          <p style={{ marginBottom: 8 }}>‘{cat.name}’ 을(를) 삭제합니다.</p>
          <p className="text-ink-2" style={{ fontSize: 12, marginBottom: 4 }}>
            하위 카테고리 {kidCount}개는 ‘{parentLabel}’(으)로 이동합니다.
          </p>
          <p className="text-ink-2" style={{ fontSize: 12, marginBottom: 12 }}>
            구독 {subCount}건은 ‘{cat.parentId ? parentLabel : "미분류"}’(으)로
            이동합니다. 구독 자체는 삭제되지 않습니다.
          </p>
          <button
            className="btn btn-sm"
            style={{ borderColor: "var(--fail)", color: "var(--fail)" }}
            onClick={async () => {
              try {
                await api.categories.remove(cat.id);
                setModal(null);
                setSelectedId(cat.parentId);
                showToast("카테고리를 삭제했습니다");
                load();
              } catch (err) {
                apiError(err);
              }
            }}
          >
            삭제
          </button>
        </div>
      ),
    });
  }

  function openMergeModal() {
    const cat = selectedId ? categoriesById.get(selectedId) : null;
    if (!cat) return showToast("카테고리를 선택하세요");
    const targets = categories.filter(
      (c) => c.id !== cat.id && !isDescendantOrSelf(c.id, cat.id),
    );
    if (!targets.length)
      return showToast("병합할 대상 카테고리가 없습니다");
    const ModalBody = () => {
      const [target, setTarget] = useState(targets[0].id);
      const kidCount = childrenOf(cat.id).length;
      const subCount = directSubCount(cat.id);
      return (
        <div>
          <label className="text-ink-2 block mb-1" style={{ fontSize: 11 }}>
            대상 카테고리
          </label>
          <select
            className="input-line mb-3"
            style={{ fontSize: 13 }}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            {targets.map((c) => (
              <option key={c.id} value={c.id}>
                {categoryPath(c.id)}
              </option>
            ))}
          </select>
          <p className="text-ink-2" style={{ fontSize: 12, marginBottom: 12 }}>
            하위 카테고리 {kidCount}개, 구독 {subCount}건이 ‘
            {categoryPath(target)}’(으)로 이동한 뒤 ‘{cat.name}’ 은(는)
            삭제됩니다.
          </p>
          <button
            className="btn btn-primary btn-sm"
            onClick={async () => {
              try {
                await api.categories.merge(cat.id, target);
                setModal(null);
                setSelectedId(target);
                showToast(`‘${categoryPath(target)}’(으)로 병합했습니다`);
                load();
              } catch (err) {
                apiError(err);
              }
            }}
          >
            병합
          </button>
        </div>
      );
    };
    setModal({ title: "카테고리 병합", body: <ModalBody /> });
  }

  async function addTag() {
    const name = newTagName.trim();
    if (!name) return;
    try {
      await api.tags.create({ name });
      setNewTagName("");
      showToast(`태그 ‘${name}’ 을(를) 추가했습니다`);
      load();
    } catch (err) {
      apiError(err);
    }
  }

  const selectedSubs = subs.filter((s) => s.categoryId === selectedId);
  const subsSelectedIds = Object.keys(subsSelected).filter(
    (k) => subsSelected[k],
  );

  return (
    <div>
      <Masthead />
      <div
        ref={setGridEl}
        style={{
          display: "grid",
          gridTemplateColumns: "var(--pane-0-width, 420px) minmax(0,1fr)",
          height: "calc(100vh - 44px)",
        }}
      >
        {/* 좌측: 트리 */}
        <aside
          style={{
            borderRight: "1px solid var(--rule)",
            overflowY: "auto",
          }}
        >
          <div className="px-4 pt-4">
            <h1 style={{ fontSize: 18, fontWeight: 700 }}>분류 정리</h1>
            <div className="rule-double" style={{ marginTop: 4, marginBottom: 10 }} />
            <div className="flex items-center gap-2 flex-wrap mb-2">
              <button className="btn btn-sm" onClick={openCreateModal}>
                새 카테고리
              </button>
              <button
                className="btn btn-sm"
                onClick={() => {
                  const cat = selectedId && categoriesById.get(selectedId);
                  if (!cat) return showToast("카테고리를 선택하세요");
                  inputModal("이름 변경", cat.name, "변경", async (name) => {
                    try {
                      await api.categories.update(cat.id, { name });
                      setModal(null);
                      showToast("이름을 변경했습니다");
                      load();
                    } catch (err) {
                      apiError(err);
                    }
                  });
                }}
              >
                이름 변경
              </button>
              <button className="btn btn-sm" onClick={openDeleteModal}>
                삭제
              </button>
              <button className="btn btn-sm" onClick={openMergeModal}>
                병합
              </button>
            </div>
            <div
              className="font-mono text-ink-2"
              style={{ fontSize: 11 }}
            >
              드래그 핸들 ⋮⋮ 로 카테고리를 다른 카테고리 위에 놓으면 하위로
              이동합니다. 깊이 최대 4단계.
            </div>
          </div>
          <div className="px-2 pb-4 pt-2">
            {childrenOf(null).map((c) => renderTreeNode(c, 0))}
          </div>
          <div
            className="font-mono text-ink-2"
            style={{
              margin: "10px 12px",
              border:
                dropTarget === "root"
                  ? "1px solid var(--blue)"
                  : "1px dashed var(--rule)",
              padding: 8,
              textAlign: "center",
              fontSize: 11,
              outline:
                dropTarget === "root" ? "2px solid var(--blue)" : undefined,
              outlineOffset: -2,
            }}
            onDragOver={(e) => e.preventDefault()}
            onDragEnter={(e) => {
              e.preventDefault();
              setDropTarget("root");
            }}
            onDragLeave={() =>
              setDropTarget((d) => (d === "root" ? null : d))
            }
            onDrop={(e) => {
              e.preventDefault();
              setDropTarget(null);
              const data = e.dataTransfer.getData("text/plain");
              if (data.startsWith("category:"))
                void moveCategory(data.slice(9), null);
            }}
          >
            여기로 놓으면 최상위로 이동
          </div>
        </aside>

        {/* 우측: 구독 + 태그 */}
        <main style={{ overflowY: "auto" }} className="px-5 py-4">
          <div className="flex items-baseline justify-between">
            <div style={{ fontSize: 18, fontWeight: 700 }}>
              {categoryPath(selectedId)}
            </div>
            <div className="font-mono text-ink-2" style={{ fontSize: 11 }}>
              {selectedSubs.length}건 구독
            </div>
          </div>
          <div className="rule-double" style={{ marginTop: 4, marginBottom: 10 }} />

          {selectedSubs.length === 0 ? (
            <div className="text-ink-2" style={{ fontSize: 12 }}>
              이 카테고리에 속한 구독이 없습니다. 오른쪽 목록의 항목을 왼쪽
              트리 노드 위로 드래그해 이동할 수 있습니다.
            </div>
          ) : (
            selectedSubs.map((s) => {
              const tagNames = s.tagIds
                .map((tid) => tags.find((t) => t.id === tid)?.name ?? tid)
                .join(", ");
              return (
                <div
                  key={s.id}
                  className="flex items-center gap-2"
                  style={{
                    padding: "6px 0",
                    borderBottom: "1px solid var(--rule)",
                    cursor: "grab",
                  }}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData("text/plain", `source:${s.id}`);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                >
                  <input
                    type="checkbox"
                    checked={!!subsSelected[s.id]}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) =>
                      setSubsSelected((m) => {
                        const next = { ...m };
                        if (e.target.checked) next[s.id] = true;
                        else delete next[s.id];
                        return next;
                      })
                    }
                  />
                  <span className="font-mono text-ink-2 select-none">⋮⋮</span>
                  <span className="flex-1 min-w-0 truncate" style={{ fontSize: 13 }}>
                    {s.displayName}
                  </span>
                  <span className="font-mono text-ink-2" style={{ fontSize: 11 }}>
                    {tagNames}
                  </span>
                </div>
              );
            })
          )}

          {subsSelectedIds.length > 0 && (
            <div
              className="flex items-center gap-2 mt-2"
              style={{
                background: "var(--paper-2)",
                border: "1px solid var(--rule)",
                padding: "8px 10px",
                fontSize: 12,
              }}
            >
              <span>{subsSelectedIds.length}건 선택됨</span>
              <label className="flex items-center gap-1">
                이동 대상
                <select
                  className="input-line"
                  style={{ width: "auto", padding: "2px 4px", fontSize: 12 }}
                  value={bulkTarget}
                  onChange={(e) => setBulkTarget(e.target.value)}
                >
                  <option value="">선택…</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {categoryPath(c.id)}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="btn btn-sm"
                disabled={!bulkTarget}
                onClick={async () => {
                  try {
                    await api.subscriptions.bulk({
                      subscriptionIds: subsSelectedIds,
                      action: "move",
                      categoryId: bulkTarget,
                    });
                    showToast(
                      `${subsSelectedIds.length}건을 ‘${categoryPath(bulkTarget)}’(으)로 이동했습니다`,
                    );
                    setSubsSelected({});
                    load();
                  } catch (err) {
                    apiError(err);
                  }
                }}
              >
                이동
              </button>
            </div>
          )}

          <div className="rule-double" style={{ marginTop: 26, marginBottom: 10 }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>태그 관리</div>
          </div>
          {tags.map((t) => {
            const usage = subs.filter((s) => s.tagIds.includes(t.id)).length;
            return (
              <div
                key={t.id}
                className="flex items-center justify-between"
                style={{
                  padding: "5px 0",
                  borderBottom: "1px solid var(--rule)",
                  fontSize: 12,
                }}
              >
                <span>
                  #{t.name}{" "}
                  <span className="font-mono text-ink-2">({usage})</span>
                </span>
                <span className="flex items-center gap-2">
                  <button
                    className="btn btn-sm"
                    onClick={() =>
                      inputModal("태그 이름 변경", t.name, "변경", async (name) => {
                        try {
                          await api.tags.update(t.id, { name });
                          setModal(null);
                          showToast("태그 이름을 변경했습니다");
                          load();
                        } catch (err) {
                          apiError(err);
                        }
                      })
                    }
                  >
                    이름변경
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={() =>
                      setModal({
                        title: "태그 삭제",
                        body: (
                          <div>
                            <p style={{ marginBottom: 10 }}>
                              ‘#{t.name}’ 태그를 삭제하면 {usage}건의 구독에서 이
                              태그가 제거됩니다.
                            </p>
                            <button
                              className="btn btn-sm"
                              style={{
                                borderColor: "var(--fail)",
                                color: "var(--fail)",
                              }}
                              onClick={async () => {
                                try {
                                  await api.tags.remove(t.id);
                                  setModal(null);
                                  showToast("태그를 삭제했습니다");
                                  load();
                                } catch (err) {
                                  apiError(err);
                                }
                              }}
                            >
                              삭제
                            </button>
                          </div>
                        ),
                      })
                    }
                  >
                    삭제
                  </button>
                </span>
              </div>
            );
          })}
          <div className="flex items-center gap-2 mt-3">
            <input
              className="input-line"
              style={{ fontSize: 12, width: 160 }}
              placeholder="새 태그 이름"
              value={newTagName}
              onChange={(e) => setNewTagName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void addTag();
              }}
            />
            <button className="btn btn-sm" onClick={() => void addTag()}>
              태그 추가
            </button>
          </div>
        </main>
      </div>

      {/* 공용 모달 */}
      {modal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.35)",
            zIndex: 300,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setModal(null);
          }}
        >
          <div
            style={{
              background: "var(--paper)",
              border: "1px solid var(--ink)",
              minWidth: 420,
              maxWidth: 560,
            }}
          >
            <div className="px-4 pt-4">
              <div className="rule-double">
                <h2 style={{ fontSize: 16, fontWeight: 700 }}>{modal.title}</h2>
              </div>
            </div>
            <div className="px-4 py-3" style={{ fontSize: 13 }}>
              {modal.body}
            </div>
            <div className="px-4 pb-4 text-right">
              <button className="btn btn-sm" onClick={() => setModal(null)}>
                취소
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
