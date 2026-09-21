import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "myportal",
  description: "개인 정보 모니터링 데스크",
};

// 저장된 테마를 최대한 빨리 적용해 깜빡임을 줄인다 (프로토타입 shell.js 동작 이식).
const themeInit = `(function(){try{var t=window.localStorage.getItem('myportal-theme');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body className="bg-paper text-ink font-sans">{children}</body>
    </html>
  );
}
