"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  currentEffectiveTheme,
  formatMastheadDate,
  formatTimeHM,
  toggleTheme,
} from "@/lib/shell";

const NAV_ITEMS = [
  { id: "index", label: "데스크", href: "/" },
  { id: "add-source", label: "소스 등록", href: "/add-source" },
  { id: "sources", label: "소스", href: "/sources" },
  { id: "categories", label: "분류 정리", href: "/categories" },
  { id: "schema-map", label: "구조 조망", href: "/schema-map" },
  { id: "keywords", label: "키워드", href: "/keywords" },
  { id: "digest", label: "다이제스트", href: "/digest" },
];

function activePageFor(pathname: string): string {
  if (pathname === "/") return "index";
  const seg = pathname.split("/")[1];
  if (seg === "sources") return "sources";
  return seg;
}

export interface MastheadMeta {
  lastCollectAt: string | null;
  sourceCount: number;
  warnCount: number;
  userEmail: string;
}

export function Masthead({ meta }: { meta?: MastheadMeta }) {
  const pathname = usePathname();
  const [theme, setTheme] = useState<"dark" | "light">("light");
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setTheme(currentEffectiveTheme());
    setNow(new Date());
  }, []);

  const active = activePageFor(pathname);
  const initials = (meta?.userEmail ?? "TT").slice(0, 2).toUpperCase();
  const lastCollect = meta?.lastCollectAt
    ? formatTimeHM(new Date(meta.lastCollectAt))
    : now
      ? formatTimeHM(now)
      : "--:--";

  return (
    <header id="masthead" style={{ height: 44 }}>
      <div
        className="h-full flex items-center justify-between gap-6 px-4"
        style={{
          borderBottom: "2px solid var(--ink)",
          boxShadow: "0 1px 0 var(--rule)",
        }}
      >
        <Link
          href="/"
          className="shrink-0"
          style={{ fontSize: 20, fontWeight: 700, color: "var(--ink)" }}
        >
          myportal
        </Link>
        <div
          className="hidden md:block font-mono text-ink-2 shrink-0"
          style={{ fontSize: 12 }}
        >
          {now ? formatMastheadDate(now) : ""}
        </div>
        <div className="flex items-center gap-4 min-w-0 justify-end flex-1">
          <div
            className="font-mono text-ink-2 shrink-0 hidden lg:block"
            style={{ fontSize: 11 }}
          >
            최근 수집 {lastCollect} · 소스 {meta?.sourceCount ?? 0} · 주의{" "}
            {meta?.warnCount ?? 0}
          </div>
          <nav
            className="hidden lg:flex items-center gap-3"
            style={{ fontSize: 12 }}
          >
            {NAV_ITEMS.map((item, i) => (
              <span key={item.id} className="flex items-center gap-3">
                {i > 0 && (
                  <span className="text-ink-2" aria-hidden="true">
                    ·
                  </span>
                )}
                <Link
                  href={item.href}
                  className={
                    item.id === active
                      ? "text-ink border-b border-ink pb-0.5"
                      : "text-ink-2 hover:text-ink"
                  }
                  style={{
                    transition:
                      "color var(--transition) ease, border-color var(--transition) ease",
                  }}
                >
                  {item.label}
                </Link>
              </span>
            ))}
          </nav>
          <button
            id="theme-toggle"
            type="button"
            className="btn btn-sm shrink-0"
            aria-label={
              theme === "dark" ? "주간 모드로 전환" : "야간 모드로 전환"
            }
            title={theme === "dark" ? "주간 모드로 전환" : "야간 모드로 전환"}
            onClick={() => setTheme(toggleTheme())}
          >
            {theme === "dark" ? "주간" : "야간"}
          </button>
          <div
            className="stamp shrink-0"
            style={{
              width: 28,
              height: 28,
              fontSize: 11,
              borderColor: "var(--ink)",
              color: "var(--ink)",
            }}
            title={meta?.userEmail ?? ""}
          >
            {initials}
          </div>
        </div>
      </div>
    </header>
  );
}
