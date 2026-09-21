// Next.js 없이 tsx로 실행되는 스크립트용 환경 로더.
// 반드시 다른 import보다 먼저 import해야 한다 — env.ts는
// 모듈 평가 시점에 process.env를 읽으므로 import 순서가 곧 실행 순서다.
import { existsSync } from "fs";
import { join } from "path";

for (const name of [".env.local", ".env"]) {
  const p = join(process.cwd(), name);
  if (existsSync(p)) process.loadEnvFile(p);
}
