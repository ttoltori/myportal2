"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

// Supabase 매직링크는 #access_token=... 해시로 돌아온다.
// 해시는 서버에 전달되지 않으므로 클라이언트에서 읽어 세션 교환 API로 보낸다.
export default function AuthCallbackPage() {
  const router = useRouter();
  const [message, setMessage] = useState("로그인 확인 중…");

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const accessToken = params.get("access_token");
    if (!accessToken) {
      setMessage("유효하지 않은 로그인 링크입니다.");
      return;
    }
    fetch("/api/v1/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessToken }),
    })
      .then(async (res) => {
        const json = await res.json();
        if (json.success) {
          router.replace("/");
        } else {
          setMessage(json.error?.message ?? "로그인에 실패했습니다.");
        }
      })
      .catch(() => setMessage("로그인에 실패했습니다."));
  }, [router]);

  return (
    <div
      className="flex items-center justify-center"
      style={{ minHeight: "100vh" }}
    >
      <div className="font-mono text-ink-2" style={{ fontSize: 13 }}>
        {message}
      </div>
    </div>
  );
}
