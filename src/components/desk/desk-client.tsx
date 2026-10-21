"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { DeskPayload, Item, Subscription } from "@myportal/api-contracts";
import { api, isAuthError, ApiError } from "@/lib/api";
import {
  escapeHtml,
  formatTimeHM,
  pad2,
  showToast,
  showUndoBand,
} from "@/lib/shell";
import { Masthead } from "@/components/masthead";
import { useResizable } from "@/components/desk/use-resizable";

type Scope = { type: "special" | "category" | "tag"; id: string };
type Density = "compact" | "comfortable";
type SortBy = "collected" | "published" | "deadline";

const SPECIAL_VIEWS = [
  { id: "all-new", label: "전체 새 글" },
  { id: "kw-alert", label: "키워드 알림" },
  { id: "deadline", label: "마감 임박" },
  { id: "starred", label: "별표" },
  { id: "warn-sources", label: "주의 소스" },
];

const STATUS_LABELS: Record<string, string> = {
  ok: "정상",
  warn: "주의",
  fail: "실패",
  pause: "일시정지",
  link: "링크",
};

const STATUS_STAMP: Record<string, string> = {
  ok: "stamp stamp-ok",
  warn: "stamp stamp-warn",
  fail: "stamp stamp-fail",
  pause: "stamp stamp-pause",
  link: "stamp stamp-link",
};

interface DeskState {
  scope: Scope;
  density: Density;
  sortBy: SortBy;
  unreadOnly: boolean;
  selectedId: string | null;
}

// ── 항목 헬퍼 (prototype index.html 이식) ────────────────

function isMuted(item: Item) {
  return item.ruleMatch?.action === "mute";
}
function isAlert(item: Item) {
  return item.ruleMatch?.action === "alert";
}

function deadlineDate(item: Item): Date | null {
  return item.deadlineAt ? new Date(item.deadlineAt) : null;
}

function ddayInfo(deadline: Date, now: Date) {
  const diffDays = Math.ceil((deadline.getTime() - now.getTime()) / 86400000);
  if (diffDays < 0) return { label: "마감", cls: "dday dday-past" };
  if (diffDays === 0) return { label: "D-DAY", cls: "dday dday-urgent" };
  return {
    label: `D-${diffDays}`,
    cls: diffDays <= 3 ? "dday dday-urgent" : "dday",
  };
}

function formatDateShort(iso: string) {
  const parts = iso.slice(0, 10).split("-");
  return `${parts[1]}.${parts[2]}`;
}

function fieldValueLabel(
  type: string,
  value: unknown,
): string | null {
  if (value === undefined || value === null || value === "") return null;
  switch (type) {
    case "date_range": {
      const v = value as { start?: string; end?: string };
      return `${v.start ? formatDateShort(v.start) : "?"}~${v.end ? formatDateShort(v.end) : "?"}`;
    }
    case "tag_list":
      return Array.isArray(value) ? value.join(", ") : String(value);
    case "date":
    case "datetime":
      return formatDateShort(String(value));
    default:
      return String(value);
  }
}

function metaPairs(
  item: Item,
  sub: Subscription | null | undefined,
  limit: number | null,
): { label: string; value: string }[] {
  if (!sub) return [];
  const pairs: { label: string; value: string }[] = [];
  for (const f of sub.fields) {
    if (f.type === "url" || f.type === "image" || !f.visible) continue;
    const v = fieldValueLabel(f.type, item.attrs[f.key]);
    if (v !== null) pairs.push({ label: f.label, value: v });
  }
  return limit ? pairs.slice(0, limit) : pairs;
}

export function DeskClient() {
  const router = useRouter();
  const [payload, setPayload] = useState<DeskPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<DeskState>({
    scope: { type: "special", id: "all-new" },
    density: "comfortable",
    sortBy: "collected",
    unreadOnly: false,
    selectedId: null,
  });
  const [treeExpanded, setTreeExpanded] = useState<Record<string, boolean>>({});
  const [expandedClusters, setExpandedClusters] = useState<Record<string, boolean>>({});
  const [showMutedByScope, setShowMutedByScope] = useState<Record<string, boolean>>({});
  const [helpOpen, setHelpOpen] = useState(false);
  const [rightDrawer, setRightDrawer] = useState(false);
  const lastBulk = useRef<{ ids: string[]; prevRead: Record<string, boolean> } | null>(null);

  // 데이터 로딩 전에는 #app이 렌더링되지 않으므로 콜백 ref로
  // 요소 마운트를 감지한다 — useResizable에 RefObject를 넘기면
  // 마운트 시점에 current가 null인 채로 effect가 끝난다.
  const [appEl, setAppEl] = useState<HTMLDivElement | null>(null);
  useResizable(appEl, "myportal-resize-index");

  // ── 데이터 로드 ─────────────────────────────────────
  useEffect(() => {
    api.desk
      .get()
      .then((p) => {
        setPayload(p);
        const expanded: Record<string, boolean> = {};
        for (const c of p.categories) expanded[c.id] = true;
        setTreeExpanded(expanded);
      })
      .catch((err) => {
        if (isAuthError(err)) {
          router.replace("/login");
          return;
        }
        setError(
          err instanceof ApiError ? err.message : "데스크를 불러오지 못했습니다.",
        );
      });
    // 마지막 방문 시각은 별도로 확정한다 (heartbeat가 last_visit을 옮긴다).
    api.desk.heartbeat().catch(() => {});
  }, [router]);

  const now = useMemo(
    () => (payload ? new Date(payload.now) : new Date()),
    [payload],
  );
  const lastVisit = useMemo(
    () =>
      payload?.lastVisitAt ? new Date(payload.lastVisitAt) : new Date(0),
    [payload],
  );

  // ── 인덱스 맵 ───────────────────────────────────────
  const categoriesById = useMemo(() => {
    const m = new Map<string, DeskPayload["categories"][number]>();
    payload?.categories.forEach((c) => m.set(c.id, c));
    return m;
  }, [payload]);

  const childrenByParent = useMemo(() => {
    const m = new Map<string, DeskPayload["categories"]>();
    payload?.categories.forEach((c) => {
      const key = c.parentId ?? "__root__";
      const list = m.get(key) ?? [];
      list.push(c);
      m.set(key, list);
    });
    return m;
  }, [payload]);

  const subsBySourceId = useMemo(() => {
    const m = new Map<string, Subscription>();
    payload?.subscriptions.forEach((s) => m.set(s.sourceId, s));
    return m;
  }, [payload]);

  const clustersById = useMemo(() => {
    const m = new Map<string, DeskPayload["clusters"][number]>();
    payload?.clusters.forEach((c) => m.set(c.id, c));
    return m;
  }, [payload]);

  const clusterMembers = useMemo(() => {
    const m = new Map<string, Item[]>();
    payload?.items.forEach((it) => {
      if (!it.clusterId) return;
      const list = m.get(it.clusterId) ?? [];
      list.push(it);
      m.set(it.clusterId, list);
    });
    m.forEach((list) =>
      list.sort(
        (a, b) =>
          new Date(a.collectedAt).getTime() - new Date(b.collectedAt).getTime(),
      ),
    );
    return m;
  }, [payload]);

  const itemsById = useMemo(() => {
    const m = new Map<string, Item>();
    payload?.items.forEach((it) => m.set(it.id, it));
    return m;
  }, [payload]);

  // ── 범위 판정 ───────────────────────────────────────
  const descendantCategoryIds = useCallback(
    (catId: string): string[] => {
      const out = [catId];
      for (const k of childrenByParent.get(catId) ?? []) {
        out.push(...descendantCategoryIds(k.id));
      }
      return out;
    },
    [childrenByParent],
  );

  const matchesScope = useCallback(
    (item: Item, scope: Scope): boolean => {
      const sub = subsBySourceId.get(item.sourceId);
      if (!sub) return false;
      if (scope.type === "category") {
        return descendantCategoryIds(scope.id).includes(sub.categoryId ?? "");
      }
      if (scope.type === "tag") {
        return sub.tagIds.includes(scope.id);
      }
      switch (scope.id) {
        case "all-new":
          return true;
        case "kw-alert":
          return isAlert(item);
        case "deadline":
          return deadlineDate(item) !== null;
        case "starred":
          return item.starred;
        case "warn-sources":
          return sub.status === "warn" || sub.status === "fail";
        default:
          return false;
      }
    },
    [subsBySourceId, descendantCategoryIds],
  );

  // ── 안읽음 집계 ─────────────────────────────────────
  const unreadCount = useCallback(
    (pred: (item: Item, sub: Subscription) => boolean): number => {
      if (!payload) return 0;
      let n = 0;
      for (const it of payload.items) {
        const sub = subsBySourceId.get(it.sourceId);
        if (!sub || isMuted(it) || it.read) continue;
        if (pred(it, sub)) n++;
      }
      return n;
    },
    [payload, subsBySourceId],
  );

  const specialViewCount = useCallback(
    (id: string): number => {
      if (!payload) return 0;
      if (id === "starred") {
        return payload.items.filter((it) => it.starred).length;
      }
      return unreadCount((it, sub) => {
        switch (id) {
          case "all-new":
            return true;
          case "kw-alert":
            return isAlert(it);
          case "deadline": {
            const dl = deadlineDate(it);
            return dl !== null && dl.getTime() >= now.getTime();
          }
          case "warn-sources":
            return sub.status === "warn" || sub.status === "fail";
          default:
            return false;
        }
      });
    },
    [payload, unreadCount, now],
  );

  const categoryUnreadCount = useCallback(
    (catId: string) => {
      const ids = descendantCategoryIds(catId);
      return unreadCount((_it, sub) => ids.includes(sub.categoryId ?? ""));
    },
    [descendantCategoryIds, unreadCount],
  );

  const categoryHasWarn = useCallback(
    (catId: string): "fail" | "warn" | null => {
      if (!payload) return null;
      const ids = descendantCategoryIds(catId);
      let worst: "fail" | "warn" | null = null;
      for (const s of payload.subscriptions) {
        if (!ids.includes(s.categoryId ?? "")) continue;
        if (s.status === "fail") worst = "fail";
        else if (s.status === "warn" && worst !== "fail") worst = "warn";
      }
      return worst;
    },
    [payload, descendantCategoryIds],
  );

  const tagUnreadCount = useCallback(
    (tagId: string) => unreadCount((_it, sub) => sub.tagIds.includes(tagId)),
    [unreadCount],
  );

  // ── 스코프 목록 ─────────────────────────────────────
  const scopeKey = `${state.scope.type}:${state.scope.id}`;

  const scopeResult = useMemo(() => {
    if (!payload) {
      return { visible: [] as Item[], mutedHidden: 0, showMuted: false, newCount: 0, flatNav: [] as string[] };
    }
    const showMuted = !!showMutedByScope[scopeKey];
    let matched = payload.items.filter((it) => matchesScope(it, state.scope));
    if (state.unreadOnly) matched = matched.filter((it) => !it.read);
    const mutedHidden = matched.filter(isMuted).length;
    let visible = showMuted ? [...matched] : matched.filter((it) => !isMuted(it));

    // 묶음 대표가 범위 안에 있으면 구성원은 접는다.
    visible = visible.filter((it) => {
      if (!it.clusterId) return true;
      const cluster = clustersById.get(it.clusterId);
      if (!cluster || cluster.representativeItemId === it.id) return true;
      const repItem = itemsById.get(cluster.representativeItemId);
      return !(repItem && matchesScope(repItem, state.scope));
    });

    visible.sort((a, b) => {
      if (state.sortBy === "published") {
        return (
          new Date(b.publishedAt ?? 0).getTime() -
          new Date(a.publishedAt ?? 0).getTime()
        );
      }
      if (state.sortBy === "deadline") {
        const da = deadlineDate(a);
        const db = deadlineDate(b);
        if (!da && !db)
          return (
            new Date(b.collectedAt).getTime() -
            new Date(a.collectedAt).getTime()
          );
        if (!da) return 1;
        if (!db) return -1;
        const aPast = da.getTime() < now.getTime();
        const bPast = db.getTime() < now.getTime();
        if (aPast !== bPast) return aPast ? 1 : -1;
        return aPast ? db.getTime() - da.getTime() : da.getTime() - db.getTime();
      }
      return (
        new Date(b.collectedAt).getTime() - new Date(a.collectedAt).getTime()
      );
    });

    const newCount =
      state.sortBy === "collected"
        ? visible.filter((it) => new Date(it.collectedAt) > lastVisit).length
        : 0;

    return { visible, mutedHidden, showMuted, newCount, scopeKey };
  }, [payload, state, showMutedByScope, scopeKey, matchesScope, clustersById, itemsById, now, lastVisit]);

  // flatNav: 렌더 순서의 j/k 이동 대상 id 목록
  const flatNav = useMemo(() => {
    const ids: string[] = [];
    for (const item of scopeResult.visible) {
      ids.push(item.id);
      if (
        item.clusterId &&
        clustersById.get(item.clusterId)?.representativeItemId === item.id &&
        expandedClusters[item.clusterId]
      ) {
        for (const m of clusterMembers.get(item.clusterId) ?? []) {
          if (m.id !== item.id) ids.push(m.id);
        }
      }
    }
    return ids;
  }, [scopeResult.visible, clustersById, clusterMembers, expandedClusters]);

  // 선택 항목이 목록에서 사라지면 첫 항목으로 이동
  useEffect(() => {
    if (!flatNav.length) {
      if (state.selectedId !== null) {
        setState((s) => ({ ...s, selectedId: null }));
      }
      return;
    }
    if (!state.selectedId || !flatNav.includes(state.selectedId)) {
      setState((s) => ({ ...s, selectedId: flatNav[0] }));
    }
  }, [flatNav, state.selectedId]);

  // ── 상태 변경 (API 연동) ────────────────────────────
  const patchItem = useCallback(
    (itemId: string, patch: Partial<Pick<Item, "read" | "starred">>) => {
      setPayload((p) =>
        p
          ? {
              ...p,
              items: p.items.map((it) =>
                it.id === itemId ? { ...it, ...patch } : it,
              ),
            }
          : p,
      );
    },
    [],
  );

  const clusterSiblingIds = useCallback(
    (itemId: string): string[] => {
      const item = itemsById.get(itemId);
      if (!item?.clusterId) return [itemId];
      return (clusterMembers.get(item.clusterId) ?? [item]).map((m) => m.id);
    },
    [itemsById, clusterMembers],
  );

  const toggleRead = useCallback(
    (itemId: string) => {
      const item = itemsById.get(itemId);
      if (!item) return;
      const ids = clusterSiblingIds(itemId);
      const target = !item.read;
      ids.forEach((id) => patchItem(id, { read: target }));
      api.items
        .restoreStates(ids, target)
        .catch(() => showToast("읽음 상태 저장에 실패했습니다"));
    },
    [itemsById, clusterSiblingIds, patchItem],
  );

  const toggleStar = useCallback(
    (itemId: string) => {
      const item = itemsById.get(itemId);
      if (!item) return;
      patchItem(itemId, { starred: !item.starred });
      api.items
        .updateState(itemId, { starred: !item.starred })
        .catch(() => showToast("별표 저장에 실패했습니다"));
    },
    [itemsById, patchItem],
  );

  const openItem = useCallback(
    (itemId: string) => {
      const item = itemsById.get(itemId);
      if (!item) return;
      const ids = clusterSiblingIds(itemId);
      ids.forEach((id) => patchItem(id, { read: true }));
      api.items.restoreStates(ids, true).catch(() => {});
      if (item.url) window.open(item.url, "_blank", "noopener");
      showToast("원문을 새 탭으로 엽니다");
    },
    [itemsById, clusterSiblingIds, patchItem],
  );

  const markScopeRead = useCallback(() => {
    if (!payload) return;
    const targets = payload.items.filter(
      (it) => matchesScope(it, state.scope) && !it.read,
    );
    if (!targets.length) return;
    const prevRead: Record<string, boolean> = {};
    targets.forEach((it) => {
      prevRead[it.id] = it.read;
    });
    lastBulk.current = { ids: targets.map((it) => it.id), prevRead };
    targets.forEach((it) => patchItem(it.id, { read: true }));
    const ids = lastBulk.current.ids;
    api.items.restoreStates(ids, true).catch(() => {});
    showUndoBand(`${ids.length}건 읽음 처리했습니다`, () => {
      const bulk = lastBulk.current;
      if (!bulk) return;
      bulk.ids.forEach((id) => patchItem(id, { read: false }));
      api.items.restoreStates(bulk.ids, false).catch(() => {});
      lastBulk.current = null;
    });
  }, [payload, matchesScope, state.scope, patchItem]);

  // ── 키보드 ──────────────────────────────────────────
  const moveCursor = useCallback(
    (delta: number) => {
      if (!flatNav.length) return;
      const idx = flatNav.indexOf(state.selectedId ?? "");
      const next =
        idx === -1 ? 0 : Math.min(flatNav.length - 1, Math.max(0, idx + delta));
      const id = flatNav[next];
      setState((s) => ({ ...s, selectedId: id }));
      setRightDrawer(true);
      requestAnimationFrame(() => {
        document
          .querySelector(`[data-item-id="${id}"]`)
          ?.scrollIntoView({ block: "nearest" });
      });
    },
    [flatNav, state.selectedId],
  );

  useEffect(() => {
    const handler = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement)?.tagName ?? "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if (ev.key === "?") {
        ev.preventDefault();
        setHelpOpen((v) => !v);
        return;
      }
      if (ev.key === "Escape") {
        setHelpOpen(false);
        return;
      }
      if (helpOpen) return;

      switch (ev.key) {
        case "j":
          ev.preventDefault();
          moveCursor(1);
          break;
        case "k":
          ev.preventDefault();
          moveCursor(-1);
          break;
        case "m":
          if (state.selectedId) {
            ev.preventDefault();
            toggleRead(state.selectedId);
          }
          break;
        case "s":
          if (state.selectedId) {
            ev.preventDefault();
            toggleStar(state.selectedId);
          }
          break;
        case "o":
        case "Enter":
          if (state.selectedId) {
            ev.preventDefault();
            openItem(state.selectedId);
          }
          break;
        case "A":
          if (ev.shiftKey) {
            ev.preventDefault();
            markScopeRead();
          }
          break;
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [helpOpen, moveCursor, state.selectedId, toggleRead, toggleStar, openItem, markScopeRead]);

  // ── 렌더 헬퍼 ───────────────────────────────────────
  function scopeHeading(): string {
    const s = state.scope;
    if (s.type === "special") {
      const map: Record<string, string> = {
        "all-new": "전체 새 글",
        "kw-alert": "키워드 알림",
        deadline: "마감 임박",
        starred: "별표",
        "warn-sources": "주의 소스",
      };
      return map[s.id] ?? "전체 새 글";
    }
    if (s.type === "category") return categoryPathLabel(s.id);
    const t = payload?.tags.find((x) => x.id === s.id);
    return "#" + (t?.name ?? s.id);
  }

  function categoryPathLabel(catId: string): string {
    const cat = categoriesById.get(catId);
    if (!cat) return "";
    if (!cat.parentId) return cat.name;
    return categoryPathLabel(cat.parentId) + " > " + cat.name;
  }

  function highlightTitle(item: Item) {
    const keywords =
      item.ruleMatch && item.ruleMatch.action !== "mute"
        ? payload?.keywordRules.find((r) => r.id === item.ruleMatch?.ruleId)
            ?.keywords ?? []
        : [];
    if (!keywords.length) return <>{item.title}</>;
    // 키워드별로 <mark>를 씌운다 — HTML 이스케이프는 React가 처리.
    const parts: (string | React.JSX.Element)[] = [item.title];
    for (const kw of keywords) {
      if (!kw) continue;
      const re = new RegExp(
        kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "gi",
      );
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        if (typeof p !== "string") continue;
        const out: (string | React.JSX.Element)[] = [];
        let last = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(p))) {
          out.push(p.slice(last, m.index));
          out.push(
            <mark key={`${i}-${m.index}`} className="kw-mark">
              {m[0]}
            </mark>,
          );
          last = m.index + m[0].length;
        }
        out.push(p.slice(last));
        parts.splice(i, 1, ...out);
      }
    }
    return <>{parts}</>;
  }

  function ruleTag(item: Item) {
    if (!item.ruleMatch) return null;
    const rule = payload?.keywordRules.find(
      (r) => r.id === item.ruleMatch?.ruleId,
    );
    if (!rule) return null;
    if (item.ruleMatch.action === "mute") {
      return (
        <span
          className="kw-tag"
          style={{ color: "var(--ink-2)", borderColor: "var(--ink-2)" }}
        >
          뮤트: {rule.name}
        </span>
      );
    }
    return <span className="kw-tag">{rule.name}</span>;
  }

  function renderItemRow(
    item: Item,
    opts: { indent?: number; isChild?: boolean } = {},
  ) {
    const sub = subsBySourceId.get(item.sourceId);
    const selected = state.selectedId === item.id;
    const rowCls =
      "item-row " +
      (item.read ? "row-read" : "row-new") +
      (selected ? " cursor-row" : "");
    const timeLabel = formatTimeHM(
      new Date(
        state.sortBy === "published"
          ? (item.publishedAt ?? item.collectedAt)
          : item.collectedAt,
      ),
    );
    const dl = deadlineDate(item);
    const pairs =
      state.density === "comfortable" ? metaPairs(item, sub, 3) : [];

    const members = item.clusterId
      ? clusterMembers.get(item.clusterId) ?? []
      : [];
    const isRep =
      item.clusterId &&
      clustersById.get(item.clusterId)?.representativeItemId === item.id;
    const otherCount = members.length - 1;

    return (
      <div
        key={item.id}
        className={rowCls}
        data-item-id={item.id}
        style={opts.indent ? { paddingLeft: opts.indent } : undefined}
      >
        <div
          className="flex items-baseline justify-between gap-3 py-1.5 cursor-pointer"
          onClick={() => {
            setState((s) => ({ ...s, selectedId: item.id }));
            setRightDrawer(true);
          }}
        >
          <div className="min-w-0 flex-1 flex items-baseline">
            {item.starred && (
              <span className="text-amber" style={{ marginRight: 4 }} title="별표">
                ★
              </span>
            )}
            {dl && (
              <span className={ddayInfo(dl, now).cls} style={{ marginRight: 6 }}>
                {ddayInfo(dl, now).label}
              </span>
            )}
            <span
              className="row-title truncate flex-1 min-w-0"
              style={{ fontSize: 13 }}
            >
              {highlightTitle(item)}
            </span>
            {ruleTag(item)}
          </div>
          <div
            className="shrink-0 font-mono text-ink-2"
            style={{ fontSize: 11, paddingLeft: 10 }}
          >
            {sub?.displayName ?? ""} · {timeLabel}
          </div>
        </div>
        {pairs.length > 0 && (
          <div
            className="font-mono text-ink-2"
            style={{ fontSize: 11, paddingBottom: 6 }}
          >
            {pairs.map((p) => `${p.label} ${p.value}`).join("\u00a0\u00a0\u00a0")}
          </div>
        )}
        {!opts.isChild && isRep && otherCount > 0 && (
          <div
            className="font-mono text-blue"
            style={{ fontSize: 11, paddingBottom: 6, cursor: "pointer" }}
            onClick={(e) => {
              e.stopPropagation();
              setExpandedClusters((m) => ({
                ...m,
                [item.clusterId!]: !m[item.clusterId!],
              }));
            }}
          >
            {expandedClusters[item.clusterId!]
              ? "− 접기"
              : `+${otherCount} 다른 출처`}
          </div>
        )}
      </div>
    );
  }

  // ── 로딩/에러 ───────────────────────────────────────
  if (error) {
    return (
      <div>
        <Masthead />
        <div className="p-8 font-mono text-ink-2" style={{ fontSize: 13 }}>
          {error}
        </div>
      </div>
    );
  }
  if (!payload) {
    return (
      <div>
        <Masthead />
        <div className="p-8 font-mono text-ink-2" style={{ fontSize: 13 }}>
          데스크를 불러오는 중…
        </div>
      </div>
    );
  }

  const selected = state.selectedId ? itemsById.get(state.selectedId) : null;
  const selectedSub = selected ? subsBySourceId.get(selected.sourceId) : null;

  const showDivider =
    state.sortBy === "collected" &&
    scopeResult.newCount > 0 &&
    scopeResult.newCount < scopeResult.visible.length;
  const dividerLabel = `${pad2(lastVisit.getMonth() + 1)}.${pad2(lastVisit.getDate())} ${formatTimeHM(lastVisit)}`;

  // ── JSX ─────────────────────────────────────────────
  return (
    <div>
      <Masthead
        meta={{
          lastCollectAt: payload.meta.lastCollectAt,
          sourceCount: payload.meta.sourceCount,
          warnCount: payload.meta.warnCount,
          userEmail: payload.meta.userEmail,
        }}
      />

      <div
        id="app"
        ref={setAppEl}
        style={{
          display: "grid",
          gridTemplateColumns:
            "var(--pane-0-width, 260px) minmax(480px, 1fr) var(--pane-2-width, 400px)",
          height: "calc(100vh - 44px)",
        }}
      >
        {/* 좌측: 분류함 */}
        <aside
          className="bg-paper-2 pane-scroll"
          style={{ borderRight: "1px solid var(--rule)", overflowY: "auto", height: "100%" }}
        >
          <div className="p-3">
            <div
              className="text-ink-2"
              style={{ fontSize: 10, letterSpacing: "0.04em", marginBottom: 6 }}
            >
              특수 보기
            </div>
            <ul style={{ fontSize: 13 }}>
              {SPECIAL_VIEWS.map((d) => {
                const active =
                  state.scope.type === "special" && state.scope.id === d.id;
                const count = specialViewCount(d.id);
                return (
                  <li
                    key={d.id}
                    className={`flex items-center justify-between py-1 px-1 cursor-pointer hover:text-ink${active ? " scope-active" : ""}`}
                    onClick={() => {
                      setState((s) => ({
                        ...s,
                        scope: { type: "special", id: d.id },
                        sortBy: d.id === "deadline" ? "deadline" : s.sortBy,
                      }));
                    }}
                  >
                    <span>{d.label}</span>
                    <span
                      className={`tree-count${count === 0 ? " tree-count-zero" : ""}`}
                    >
                      {count}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="p-3" style={{ borderTop: "1px solid var(--rule)" }}>
            <div
              className="text-ink-2"
              style={{ fontSize: 10, letterSpacing: "0.04em", marginBottom: 6 }}
            >
              분류
            </div>
            <div style={{ fontSize: 13 }}>
              {(childrenByParent.get("__root__") ?? []).map((c) =>
                renderTreeNode(c, 0),
              )}
            </div>
          </div>

          <div className="p-3" style={{ borderTop: "1px solid var(--rule)" }}>
            <div
              className="text-ink-2"
              style={{ fontSize: 10, letterSpacing: "0.04em", marginBottom: 6 }}
            >
              태그
            </div>
            <ul style={{ fontSize: 13 }}>
              {payload.tags.map((t) => {
                const active =
                  state.scope.type === "tag" && state.scope.id === t.id;
                const count = tagUnreadCount(t.id);
                return (
                  <li
                    key={t.id}
                    className={`flex items-center justify-between py-1 px-1 cursor-pointer hover:text-ink${active ? " scope-active" : ""}`}
                    onClick={() =>
                      setState((s) => ({
                        ...s,
                        scope: { type: "tag", id: t.id },
                      }))
                    }
                  >
                    <span className="text-ink-2">#{t.name}</span>
                    <span
                      className={`tree-count${count === 0 ? " tree-count-zero" : ""}`}
                    >
                      {count}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        </aside>

        {/* 중앙: 수신 목록 */}
        <main
          className="pane-scroll"
          style={{ borderRight: "1px solid var(--rule)", overflowY: "auto", height: "100%" }}
        >
          <div
            className="px-5 pt-4 sticky top-0 bg-paper"
            style={{ zIndex: 10 }}
          >
            <div className="flex items-end justify-between">
              <h1 style={{ fontSize: 20, fontWeight: 700 }}>
                {scopeHeading()}
              </h1>
            </div>
            <div className="rule-double" style={{ marginTop: 4 }} />

            <div
              className="flex items-center gap-4 py-2 flex-wrap"
              style={{ fontSize: 12 }}
            >
              <label className="flex items-center gap-1 text-ink-2">
                정렬
                <select
                  className="input-line"
                  style={{ width: "auto", padding: "2px 4px", fontSize: 12 }}
                  value={state.sortBy}
                  onChange={(e) =>
                    setState((s) => ({
                      ...s,
                      sortBy: e.target.value as SortBy,
                    }))
                  }
                >
                  <option value="collected">수집 시각</option>
                  <option value="published">게시 시각</option>
                  <option value="deadline">마감일</option>
                </select>
              </label>
              <label className="flex items-center gap-1 text-ink-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={state.unreadOnly}
                  onChange={(e) =>
                    setState((s) => ({ ...s, unreadOnly: e.target.checked }))
                  }
                />
                안읽음만
              </label>
              <div className="flex items-center gap-1">
                <button
                  className={`btn btn-sm${state.density === "compact" ? " btn-primary" : ""}`}
                  onClick={() =>
                    setState((s) => ({ ...s, density: "compact" }))
                  }
                >
                  조밀
                </button>
                <button
                  className={`btn btn-sm${state.density === "comfortable" ? " btn-primary" : ""}`}
                  onClick={() =>
                    setState((s) => ({ ...s, density: "comfortable" }))
                  }
                >
                  보통
                </button>
              </div>
              <div className="flex-1" />
              <button className="btn btn-sm" onClick={markScopeRead}>
                모두 읽음 처리
              </button>
            </div>
          </div>

          <div className="px-5 pb-4">
            {scopeResult.visible.length === 0 && (
              <div className="text-ink-2 py-6" style={{ fontSize: 13 }}>
                표시할 항목이 없습니다.
              </div>
            )}
            {scopeResult.visible.map((item, idx) => (
              <div key={item.id}>
                {showDivider && idx === scopeResult.newCount && (
                  <div
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 11,
                      color: "var(--red)",
                      textAlign: "center",
                      paddingTop: 8,
                      paddingBottom: 8,
                      borderTop: "1px solid var(--red)",
                      margin: "4px 0",
                    }}
                  >
                    ── 지난 방문 {dividerLabel} 이후 {scopeResult.newCount}건 ──
                  </div>
                )}
                {renderItemRow(item)}
                {item.clusterId &&
                  clustersById.get(item.clusterId)?.representativeItemId ===
                    item.id &&
                  expandedClusters[item.clusterId] &&
                  (clusterMembers.get(item.clusterId) ?? [])
                    .filter((m) => m.id !== item.id)
                    .map((m) => renderItemRow(m, { indent: 20, isChild: true }))}
              </div>
            ))}
          </div>

          {scopeResult.mutedHidden > 0 && !scopeResult.showMuted && (
            <div
              className="px-5 py-3 font-mono text-ink-2 cursor-pointer"
              style={{ fontSize: 12, borderTop: "1px solid var(--rule)" }}
              onClick={() =>
                setShowMutedByScope((m) => ({ ...m, [scopeKey]: true }))
              }
            >
              뮤트 {scopeResult.mutedHidden}건 보기
            </div>
          )}
          {scopeResult.showMuted &&
            payload.items.some(
              (it) => matchesScope(it, state.scope) && isMuted(it),
            ) && (
              <div
                className="px-5 py-3 font-mono text-ink-2 cursor-pointer"
                style={{ fontSize: 12, borderTop: "1px solid var(--rule)" }}
                onClick={() =>
                  setShowMutedByScope((m) => ({ ...m, [scopeKey]: false }))
                }
              >
                뮤트 항목 숨기기
              </div>
            )}
        </main>

        {/* 우측: 교정지 */}
        <aside
          className={`bg-paper-2 pane-scroll${rightDrawer ? " drawer-open" : ""}`}
          style={{ overflowY: "auto", height: "100%" }}
        >
          <div className="p-4">
            <button
              className="btn btn-sm mb-2"
              style={{ display: "none" }}
              onClick={() => setRightDrawer(false)}
            >
              닫기 ✕
            </button>
            {!selected ? (
              <div className="text-ink-2" style={{ fontSize: 13 }}>
                선택된 항목이 없습니다. j/k 로 이동하거나 목록에서 항목을
                클릭하세요.
              </div>
            ) : (
              <div>
                <div className="mb-3">
                  {deadlineDate(selected) && (
                    <span
                      className={ddayInfo(deadlineDate(selected)!, now).cls}
                      style={{ marginRight: 6 }}
                    >
                      {ddayInfo(deadlineDate(selected)!, now).label}
                    </span>
                  )}
                  {selected.starred && (
                    <span className="text-amber" title="별표">
                      ★
                    </span>
                  )}
                </div>
                <h2
                  style={{
                    fontSize: 15,
                    fontWeight: 700,
                    lineHeight: 1.4,
                  }}
                >
                  {selected.title}
                </h2>
                <div
                  className="font-mono text-ink-2 mt-2"
                  style={{ fontSize: 11 }}
                >
                  {selectedSub?.displayName ?? ""}{" "}
                  <span
                    className={
                      STATUS_STAMP[selectedSub?.status ?? "ok"] ??
                      "stamp stamp-ok"
                    }
                  >
                    {STATUS_LABELS[selectedSub?.status ?? "ok"]}
                  </span>
                  <br />
                  게시{" "}
                  {selected.publishedAt?.slice(0, 16).replace("T", " ") ?? "—"} ·
                  수집 {selected.collectedAt.slice(0, 16).replace("T", " ")}
                </div>

                {metaPairs(selected, selectedSub, null).length > 0 && (
                  <table
                    className="w-full mt-3"
                    style={{ borderTop: "1px solid var(--rule)" }}
                  >
                    <tbody>
                      {metaPairs(selected, selectedSub, null).map((p) => (
                        <tr key={p.label}>
                          <td
                            className="text-ink-2 pr-3 py-1 align-top font-mono"
                            style={{ fontSize: 11, whiteSpace: "nowrap" }}
                          >
                            {p.label}
                          </td>
                          <td className="py-1" style={{ fontSize: 12 }}>
                            {p.value}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {selected.excerpt && (
                  <p className="mt-3" style={{ fontSize: 13, lineHeight: 1.6 }}>
                    {selected.excerpt}
                  </p>
                )}

                <div className="flex items-center gap-2 mt-4 flex-wrap">
                  <button
                    className="btn btn-sm"
                    onClick={() => openItem(selected.id)}
                  >
                    원문 열기 [o]
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={() => toggleRead(selected.id)}
                  >
                    {selected.read ? "안읽음으로 표시 [m]" : "읽음 표시 [m]"}
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={() => toggleStar(selected.id)}
                  >
                    {selected.starred ? "별표 해제 [s]" : "별표 [s]"}
                  </button>
                </div>

                <div className="mt-3">
                  {selectedSub?.tagIds.map((tid) => {
                    const t = payload.tags.find((x) => x.id === tid);
                    return t ? (
                      <span
                        key={tid}
                        className="kw-tag"
                        style={{
                          color: "var(--ink-2)",
                          borderColor: "var(--ink-2)",
                        }}
                      >
                        #{t.name}
                      </span>
                    ) : null;
                  })}
                </div>
                {selected.url && (
                  <div
                    className="font-mono text-ink-2 mt-3 truncate"
                    style={{ fontSize: 10 }}
                    title={selected.url}
                  >
                    {selected.url}
                  </div>
                )}
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* 단축키 도움말 오버레이 */}
      {helpOpen && (
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
            if (e.target === e.currentTarget) setHelpOpen(false);
          }}
        >
          <div
            style={{
              background: "var(--paper)",
              border: "1px solid var(--ink)",
              minWidth: 360,
              maxWidth: 480,
            }}
          >
            <div className="px-4 pt-4">
              <div className="rule-double">
                <h2 style={{ fontSize: 18, fontWeight: 700 }}>단축키</h2>
              </div>
            </div>
            <div className="px-4 py-3" style={{ fontSize: 13 }}>
              {[
                ["j / k", "다음 / 이전 항목"],
                ["o / Enter", "원문 열기(읽음 처리)"],
                ["m", "읽음/안읽음 전환"],
                ["s", "별표 전환"],
                ["Shift+A", "범위 모두 읽음 처리"],
                ["?", "이 도움말 열기/닫기"],
              ].map(([keys, desc], i, arr) => (
                <div
                  key={keys}
                  className="flex justify-between py-1.5"
                  style={
                    i < arr.length - 1
                      ? { borderBottom: "1px solid var(--rule)" }
                      : undefined
                  }
                >
                  <span>
                    {keys.split(" / ").map((k, j) => (
                      <span key={j}>
                        {j > 0 && " / "}
                        <span className="kbd">{k}</span>
                      </span>
                    ))}
                  </span>
                  <span className="text-ink-2">{desc}</span>
                </div>
              ))}
            </div>
            <div className="px-4 pb-4 text-right">
              <button className="btn btn-sm" onClick={() => setHelpOpen(false)}>
                닫기 [Esc]
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  function renderTreeNode(cat: DeskPayload["categories"][number], depth: number) {
    const kids = childrenByParent.get(cat.id) ?? [];
    const hasKids = kids.length > 0;
    const expanded = !!treeExpanded[cat.id];
    const active = state.scope.type === "category" && state.scope.id === cat.id;
    const count = categoryUnreadCount(cat.id);
    const warn = categoryHasWarn(cat.id);

    return (
      <div key={cat.id}>
        <div
          className={`flex items-center justify-between py-1 px-1 cursor-pointer hover:text-ink${active ? " scope-active" : ""}`}
          style={{ paddingLeft: depth * 14 }}
          onClick={() =>
            setState((s) => ({ ...s, scope: { type: "category", id: cat.id } }))
          }
        >
          <span className="flex items-center min-w-0">
            <span
              className="tree-toggle"
              onClick={(e) => {
                e.stopPropagation();
                if (hasKids) {
                  setTreeExpanded((m) => ({ ...m, [cat.id]: !m[cat.id] }));
                }
              }}
            >
              {hasKids ? (expanded ? "▾" : "▸") : ""}
            </span>
            <span className="truncate">{cat.name}</span>
          </span>
          <span className="flex items-center shrink-0">
            {warn && (
              <span
                className={`stamp ${warn === "fail" ? "stamp-fail" : "stamp-warn"}`}
                style={{ fontSize: 9, padding: "0 3px", marginRight: 4 }}
                title="주의/실패 소스 포함"
              >
                {warn === "fail" ? "실패" : "주의"}
              </span>
            )}
            <span className={`tree-count${count === 0 ? " tree-count-zero" : ""}`}>
              {count}
            </span>
          </span>
        </div>
        {hasKids && expanded && kids.map((k) => renderTreeNode(k, depth + 1))}
      </div>
    );
  }
}
