"use client";

// 프로토타입 assets/shell.js의 React 이식 — 테마/토스트/되돌리기 띠.
const THEME_KEY = "myportal-theme";

export function getStoredTheme(): string | null {
  try {
    return window.localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
}

export function applyTheme(theme: string | null): void {
  if (theme === "dark" || theme === "light") {
    document.documentElement.setAttribute("data-theme", theme);
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
}

export function currentEffectiveTheme(): "dark" | "light" {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "dark" || attr === "light") return attr;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function toggleTheme(): "dark" | "light" {
  const next = currentEffectiveTheme() === "dark" ? "light" : "dark";
  applyTheme(next);
  try {
    window.localStorage.setItem(THEME_KEY, next);
  } catch {
    /* 저장 불가 환경이면 무시 */
  }
  return next;
}

export function escapeHtml(str: string): string {
  return String(str).replace(/[&<>"']/g, (ch) => {
    const map: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return map[ch] ?? ch;
  });
}

export function pad2(n: number): string {
  return n < 10 ? "0" + n : "" + n;
}

export function formatTimeHM(d: Date): string {
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

const WEEKDAY = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"];

export function formatMastheadDate(date: Date): string {
  return `${date.getFullYear()}년 ${date.getMonth() + 1}월 ${date.getDate()}일 ${WEEKDAY[date.getDay()]} · 조간`;
}

// ---------- 토스트 ----------
let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function showToast(message: string, duration = 1800): void {
  let el = document.getElementById("shell-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "shell-toast";
    el.className = "toast-mono";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.remove("show");
  void el.offsetWidth;
  el.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el!.classList.remove("show"), duration);
}

// ---------- 하단 되돌리기 띠 ----------
let undoTimer: ReturnType<typeof setTimeout> | null = null;

export function showUndoBand(
  message: string,
  onUndo: () => void,
  duration = 5000,
): void {
  let el = document.getElementById("shell-undo-band");
  if (!el) {
    el = document.createElement("div");
    el.id = "shell-undo-band";
    el.className = "undo-band";
    document.body.appendChild(el);
  }
  el.innerHTML = "";
  const span = document.createElement("span");
  span.className = "font-mono";
  span.textContent = message;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "되돌리기";
  el.appendChild(span);
  el.appendChild(btn);

  const hide = () => el!.classList.remove("show");
  btn.addEventListener("click", () => {
    hide();
    if (undoTimer) clearTimeout(undoTimer);
    onUndo();
  });

  void el.offsetWidth;
  el.classList.add("show");
  if (undoTimer) clearTimeout(undoTimer);
  undoTimer = setTimeout(hide, duration);
}
