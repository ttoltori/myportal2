import "./load-env"; // 반드시 첫 import — 환경변수를 먼저 로드한다.
import { closePool } from "@ttoltori/database";
import { getDb } from "../config/db";
import { analyzeListing } from "../features/crawl/analyze";
import { assertPublicUrl, normalizeUrl } from "../features/crawl/url";

// URL 하나를 소스 등록 화면과 똑같은 분석 경로(analyzeListing)로 돌려 단계·스펙·프로파일·미리보기를
// 터미널에 출력하는 디버깅 도구다. sources/crawl_specs/source_fields에는 아무것도 저장하지 않는다.
// 다만 LLM을 실제로 호출하므로 llm_calls에 이력이 남고 일별 한도를 소모한다.
//
//   pnpm analyze:url <url> [--hint "목록 항목 텍스트 일부"] [--rows 10] [--ignore-robots]

const DEFAULT_PREVIEW_ROWS = 10;
const STATUS_MARK: Record<string, string> = { ok: "OK  ", warn: "WARN", fail: "FAIL" };

function readFlag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function usage(): never {
  console.error(
    '사용법: pnpm analyze:url <url> [--hint "목록 항목 텍스트 일부"] [--rows 10] [--ignore-robots]',
  );
  process.exit(2);
}

// llm_calls.user_id가 users를 참조하고 일별 한도가 사용자별로 집계되므로 실제 사용자 한 명으로 돌린다.
async function findAnalysisUserId(): Promise<string> {
  const email = (process.env.SEED_EMAIL ?? "dev@myportal.local").toLowerCase();
  const { rows } = await getDb().query<{ id: string }>(
    "select id from myportal.users where email = $1",
    [email],
  );
  if (!rows[0]) {
    throw new Error(`사용자 ${email}가 없습니다. 먼저 pnpm db:seed 를 실행하십시오.`);
  }
  return rows[0].id;
}

async function main() {
  const rawUrl = process.argv[2];
  if (!rawUrl || rawUrl.startsWith("--")) usage();
  const hint = readFlag("--hint")?.trim() || undefined;
  const previewRows = Number(readFlag("--rows") ?? DEFAULT_PREVIEW_ROWS);
  const ignoreRobots = hasFlag("--ignore-robots");

  const url = normalizeUrl(rawUrl);
  assertPublicUrl(url);

  const userId = await findAnalysisUserId();
  const startedAt = Date.now();
  const listing = await analyzeListing({
    userId,
    url,
    hint,
    sourceId: null,
    purpose: "analyze-fields",
    ignoreRobots,
  });
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log(`\n[분석 단계] ${url}`);
  for (const s of listing.steps) {
    console.log(`  ${STATUS_MARK[s.status] ?? s.status}  ${s.label}${s.detail ? ` — ${s.detail}` : ""}`);
  }

  console.log("\n[요약]");
  console.log(`  소요 시간      ${elapsedSec}초 (실행 한도 120초)`);
  console.log(`  페이지 유형    ${listing.pageKind}`);
  console.log(`  필드 출처      ${listing.fieldSource ?? "(목록 없음)"}`);
  console.log(`  수집 전략      ${listing.outcome?.strategy ?? "(목록 없음)"}`);
  console.log(`  힌트 매칭      ${listing.hintMatched === null ? "(힌트 없음/판정 불가)" : listing.hintMatched}`);
  console.log(`  표시 이름 제안 ${listing.suggested.displayName || "(없음)"}`);
  console.log(`  카테고리 제안  ${listing.suggested.categoryPath.join(" > ") || "(없음)"}`);
  console.log(`  태그 제안      ${listing.suggested.tagNames.join(", ") || "(없음)"}`);

  console.log("\n[수집 프로파일 — sources.fetch_profile에 저장될 값]");
  console.log(JSON.stringify(listing.profile, null, 2));

  console.log("\n[추출 명세 — crawl_specs.spec에 저장될 값]");
  console.log(JSON.stringify(listing.outcome?.spec ?? null, null, 2));

  const rows = listing.outcome?.rows ?? [];
  console.log(`\n[추출 미리보기] 전체 ${rows.length}건 중 ${Math.min(previewRows, rows.length)}건`);
  for (const r of rows.slice(0, previewRows)) {
    console.log(`  - ${r.title}`);
    console.log(`      link=${r.link ?? "null"} published=${r.publishedAt ?? "null"}`);
    if (Object.keys(r.attrs).length > 0) console.log(`      attrs=${JSON.stringify(r.attrs)}`);
  }
}

main()
  .catch((err) => {
    console.error("analyze-url failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
