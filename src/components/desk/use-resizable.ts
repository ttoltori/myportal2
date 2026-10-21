"use client";

import { useEffect } from "react";

// 프로토타입 assets/resizable.js의 React 훅 이식.
// 그리드 컨테이너의 --pane-N-width CSS 변수만 갱신하므로
// 반응형 미디어쿼리는 그대로 유지된다.
const STEP = 16;
const HIT_WIDTH = 6;
const ADJACENT_TOLERANCE = 40;

export interface PaneConfig {
  default?: number;
  min: number;
  max?: number;
  responsiveDefaults?: { minWidth: number; default: number }[];
}

const DESK_PANES: PaneConfig[] = [
  { default: 260, min: 200, max: 420 },
  { min: 480 },
  {
    default: 400,
    min: 320,
    max: 720,
    responsiveDefaults: [{ minWidth: 1920, default: 480 }],
  },
];

const FLEX_INDEX = 1;

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function resolveDefault(p: PaneConfig): number {
  let d = p.default ?? p.min;
  if (p.responsiveDefaults && window.matchMedia) {
    for (const rd of p.responsiveDefaults) {
      if (window.matchMedia(`(min-width: ${rd.minWidth}px)`).matches) {
        d = rd.default;
      }
    }
  }
  return d;
}

export interface ResizableOptions {
  panes?: PaneConfig[];
  flexIndex?: number;
}

// 대상 요소가 데이터 로딩 전에는 렌더링되지 않는 화면이 있으므로
// RefObject가 아니라 요소 자체를 받는다 — 호출부는 콜백 ref + useState로
// 요소가 마운트된 뒤 effect가 실행되도록 해야 한다.
export function useResizable(
  el: HTMLElement | null,
  storageKey: string,
  opts?: ResizableOptions,
): void {
  const panes = opts?.panes ?? DESK_PANES;
  const flexIndex = opts?.flexIndex ?? FLEX_INDEX;
  const panesKey = panes
    .map((p) => `${p.min}-${p.max ?? ""}-${p.default ?? ""}`)
    .join("|");
  useEffect(() => {
    const containerEl = el;
    if (!containerEl) return;
    const paneEls = Array.from(containerEl.children).filter(
      (c): c is HTMLElement => c instanceof HTMLElement,
    );
    // splitter가 추가된 뒤에도 직계 자식 = 패널 + 분할선이 되므로
    // 분할선 추가 전에 패널 목록을 고정한다.
    if (paneEls.length !== panes.length) return;

    let stored: Record<string, number> = {};
    try {
      stored = JSON.parse(
        window.localStorage.getItem(storageKey) ?? "{}",
      ) as Record<string, number>;
    } catch {
      stored = {};
    }

    const widths: (number | null)[] = panes.map((p, i) => {
      if (i === flexIndex) return null;
      const v = stored[String(i)];
      if (typeof v === "number" && Number.isFinite(v)) {
        return clamp(v, p.min, p.max ?? Infinity);
      }
      return clamp(resolveDefault(p), p.min, p.max ?? Infinity);
    });

    const applyCssVar = (i: number) => {
      if (i === flexIndex) return;
      containerEl.style.setProperty(`--pane-${i}-width`, `${widths[i]}px`);
    };
    panes.forEach((_, i) => applyCssVar(i));

    const persist = () => {
      const out: Record<string, number> = {};
      panes.forEach((_, i) => {
        if (i !== flexIndex && typeof widths[i] === "number") {
          out[String(i)] = widths[i]!;
        }
      });
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(out));
      } catch {
        /* 무시 */
      }
    };

    if (!containerEl.style.position) {
      const pos = window.getComputedStyle?.(containerEl).position;
      if (!pos || pos === "static") containerEl.style.position = "relative";
    }

    const splitters: HTMLElement[] = [];
    for (let i = 0; i < paneEls.length - 1; i++) {
      const sp = document.createElement("div");
      sp.className = "splitter";
      sp.setAttribute("role", "separator");
      sp.setAttribute("aria-orientation", "vertical");
      sp.setAttribute("tabindex", "0");
      containerEl.appendChild(sp);
      splitters.push(sp);
    }

    function updatePositions() {
      const containerRect = containerEl!.getBoundingClientRect();
      splitters.forEach((sp, i) => {
        const lr = paneEls[i].getBoundingClientRect();
        const rr = paneEls[i + 1].getBoundingClientRect();
        const leftVisible =
          lr.width > 0 && lr.height > 0 && paneEls[i].offsetParent !== null;
        const rightVisible =
          rr.width > 0 && rr.height > 0 && paneEls[i + 1].offsetParent !== null;
        const stacked = rr.top >= lr.bottom - 1;
        const adjacent = Math.abs(rr.left - lr.right) < ADJACENT_TOLERANCE;
        if (!leftVisible || !rightVisible || stacked || !adjacent) {
          sp.style.display = "none";
          return;
        }
        sp.style.display = "";
        const boundaryX = (lr.right + rr.left) / 2 - containerRect.left;
        sp.style.left = `${boundaryX - HIT_WIDTH / 2}px`;
      });
    }
    updatePositions();

    let ro: ResizeObserver | null = null;
    if (window.ResizeObserver) {
      ro = new ResizeObserver(updatePositions);
      ro.observe(containerEl);
      paneEls.forEach((el) => ro!.observe(el));
    } else {
      window.addEventListener("resize", updatePositions);
    }

    const cleanups: (() => void)[] = [];
    splitters.forEach((sp, boundaryIdx) => {
      const leftIdx = boundaryIdx;
      const rightIdx = boundaryIdx + 1;
      const target =
        leftIdx !== flexIndex
          ? { idx: leftIdx, side: "left" as const }
          : rightIdx !== flexIndex
            ? { idx: rightIdx, side: "right" as const }
            : null;
      if (!target) return;

      let dragging = false;
      let startX = 0;
      let startWidth = 0;

      const setWidth = (next: number) => {
        widths[target.idx] = clamp(
          next,
          panes[target.idx].min,
          panes[target.idx].max ?? Infinity,
        );
        applyCssVar(target.idx);
        updatePositions();
      };

      const onMove = (ev: PointerEvent) => {
        if (!dragging) return;
        const dx = ev.clientX - startX;
        setWidth(startWidth + (target.side === "left" ? dx : -dx));
      };
      const endDrag = (ev: PointerEvent) => {
        if (!dragging) return;
        dragging = false;
        sp.classList.remove("is-dragging");
        document.body.style.userSelect = "";
        try {
          sp.releasePointerCapture(ev.pointerId);
        } catch {
          /* 무시 */
        }
        persist();
      };
      const onDown = (ev: PointerEvent) => {
        if (ev.button !== 0) return;
        dragging = true;
        startX = ev.clientX;
        startWidth = widths[target.idx] ?? 0;
        sp.classList.add("is-dragging");
        document.body.style.userSelect = "none";
        try {
          sp.setPointerCapture(ev.pointerId);
        } catch {
          /* 무시 */
        }
        ev.preventDefault();
      };
      const onDbl = () => {
        setWidth(resolveDefault(panes[target.idx]));
        persist();
      };
      const onKey = (ev: KeyboardEvent) => {
        const dir = ev.key === "ArrowLeft" ? -1 : ev.key === "ArrowRight" ? 1 : 0;
        if (!dir) return;
        ev.preventDefault();
        setWidth(
          (widths[target.idx] ?? 0) +
            (target.side === "left" ? dir * STEP : -dir * STEP),
        );
        persist();
      };

      sp.addEventListener("pointerdown", onDown);
      sp.addEventListener("pointermove", onMove);
      sp.addEventListener("pointerup", endDrag);
      sp.addEventListener("pointercancel", endDrag);
      sp.addEventListener("dblclick", onDbl);
      sp.addEventListener("keydown", onKey);
      cleanups.push(() => {
        sp.removeEventListener("pointerdown", onDown);
        sp.removeEventListener("pointermove", onMove);
        sp.removeEventListener("pointerup", endDrag);
        sp.removeEventListener("pointercancel", endDrag);
        sp.removeEventListener("dblclick", onDbl);
        sp.removeEventListener("keydown", onKey);
      });
    });

    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", updatePositions);
      cleanups.forEach((fn) => fn());
      splitters.forEach((sp) => sp.remove());
    };
  }, [el, storageKey, flexIndex, panesKey]); // eslint-disable-line react-hooks/exhaustive-deps
}
