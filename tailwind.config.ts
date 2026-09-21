import type { Config } from "tailwindcss";

// 디자인 토큰 (docs/디자인컨셉.md §4.2: 신문 조판 · 텔렉스 · 교정펜 컨셉)
// 실제 색상 값은 src/app/globals.css의 CSS 변수(--paper, --ink 등)가 결정하며,
// 라이트/다크 테마 전환은 data-theme 속성으로 처리한다.
const config: Config = {
  content: [
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        paper: {
          DEFAULT: "var(--paper)",
          2: "var(--paper-2)",
        },
        ink: {
          DEFAULT: "var(--ink)",
          2: "var(--ink-2)",
          read: "var(--ink-read)",
        },
        rule: "var(--rule)",
        red: "var(--red)",
        amber: "var(--amber)",
        blue: "var(--blue)",
        warn: "var(--warn)",
        fail: "var(--fail)",
      },
      fontFamily: {
        sans: ["var(--font-sans)"],
        mono: ["var(--font-mono)"],
        code: ["var(--font-code)"],
      },
      borderRadius: {
        none: "0",
      },
    },
  },
  plugins: [],
};

export default config;
