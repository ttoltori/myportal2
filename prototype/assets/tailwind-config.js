/*
  myportal 프로토타입 — Tailwind Play CDN 설정
  tokens.css의 CSS 변수를 Tailwind 색상/폰트 토큰으로 매핑한다.
  <script src="https://cdn.tailwindcss.com"></script> 다음에 로드한다.
*/
tailwind.config = {
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        paper: 'var(--paper)',
        'paper-2': 'var(--paper-2)',
        ink: 'var(--ink)',
        'ink-2': 'var(--ink-2)',
        'ink-read': 'var(--ink-read)',
        rule: 'var(--rule)',
        red: 'var(--red)',
        amber: 'var(--amber)',
        blue: 'var(--blue)',
        warn: 'var(--warn)',
        fail: 'var(--fail)',
      },
      fontFamily: {
        sans: ['Malgun Gothic', '맑은 고딕', 'Apple SD Gothic Neo', 'sans-serif'],
        mono: ['Malgun Gothic', '맑은 고딕', 'Apple SD Gothic Neo', 'sans-serif'],
      },
      borderRadius: {
        none: '0px',
        DEFAULT: '0px',
        sm: '0px',
        md: '0px',
        lg: '0px',
        xl: '0px',
        full: '0px',
      },
      boxShadow: {
        none: 'none',
      },
      transitionDuration: {
        DEFAULT: '200ms',
      },
    },
  },
};
