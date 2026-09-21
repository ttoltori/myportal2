import { getDb } from "../../config/db";
import type { DatabaseClient } from "@ttoltori/database";
import { AppError, errorCodes } from "../../errors/error-codes";
import { fetchPage } from "./fetcher";
import { robotsAllowed } from "./robots";
import {
  applySpec,
  generateSpec,
  looksLikeFeed,
  parseFeed,
  parseJsonLdList,
  type CrawlSpec,
  type ExtractedRow,
} from "./extract";
import { matchNewItemsForSubscribers } from "../keywords/match";
import { clusterItems } from "./cluster";
import { dedupeHash, normalizeUrl } from "./url";
import { sourcesSql } from "../sources/sources.sql";

const BASELINE_SIZE = 20;
const MIN_INTERVAL = 15;
const MAX_INTERVAL = 24 * 60;
const MANUAL_COLLECT_COOLDOWN_MIN = 5;
const EMPTY_RUNS_BEFORE_REPAIR = 2;

export interface CollectResult {
  runId: string;
  newCount: number;
  result: "ok" | "error" | "unchanged";
  errorCode: string | null;
}

// ── interval adaptation ────────────────────────────────
// Idle sources back off exponentially; busy sources return to the floor.
function nextInterval(current: number, newCount: number, fixed: boolean): number {
  if (fixed) return current;
  if (newCount > 0) return MIN_INTERVAL;
  return Math.min(current * 2, MAX_INTERVAL);
}

function nextCrawlAt(intervalMin: number): string {
  return new Date(Date.now() + intervalMin * 60_000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
}

// ── extraction by strategy ─────────────────────────────

async function extractRows(
  source: { url: string; fetch_strategy: string; feed_url: string | null },
  spec: CrawlSpec | null,
  html: string,
  contentType: string,
  finalUrl: string,
): Promise<ExtractedRow[]> {
  switch (source.fetch_strategy) {
    case "rss": {
      const feedTarget = source.feed_url ?? finalUrl;
      // If we fetched the HTML page, fetch the feed itself.
      let feedBody = html;
      let feedType = contentType;
      if (source.feed_url && feedTarget !== finalUrl) {
        const feed = await fetchPage(feedTarget);
        feedBody = feed.body;
        feedType = feed.contentType;
      }
      if (!looksLikeFeed(feedType, feedBody)) return [];
      return parseFeed(feedBody, feedTarget);
    }
    case "structured":
      return parseJsonLdList(html, finalUrl) ?? [];
    case "html":
      return spec ? applySpec(html, spec, finalUrl) : [];
    case "link":
      return [];
    default:
      return [];
  }
}

// ── spec self-repair ───────────────────────────────────
// When extraction keeps yielding zero rows, regenerate the DOM spec once
// and retry. A successful repair is persisted as a new spec version.
async function repairSpec(
  sourceId: string,
  html: string,
  finalUrl: string,
): Promise<{ spec: CrawlSpec; rows: ExtractedRow[] } | null> {
  const regenerated = generateSpec(html, finalUrl);
  if (!regenerated || regenerated.rows.length === 0) return null;

  const db = getDb();
  const { rows: versions } = await db.query<{ v: string }>(
    `select coalesce(max(version), 0) as v from myportal.crawl_specs where source_id = $1`,
    [sourceId],
  );
  const nextVersion = Number(versions[0]?.v ?? 0) + 1;
  await db.query(sourcesSql.deactivateSpecs, [sourceId]);
  await db.query(sourcesSql.insertSpec, [
    sourceId,
    nextVersion,
    JSON.stringify(regenerated.spec),
    "self-repair",
  ]);
  return { spec: regenerated.spec, rows: regenerated.rows };
}

// ── item persistence ───────────────────────────────────

async function persistItems(
  sourceId: string,
  rows: ExtractedRow[],
  baseline: boolean,
): Promise<string[]> {
  const db = getDb();
  const insertedIds: string[] = [];
  const slice = baseline ? rows.slice(0, BASELINE_SIZE) : rows.slice(0, 200);

  for (const row of slice) {
    const excerpt =
      typeof row.attrs["description"] === "string"
        ? (row.attrs["description"] as string).slice(0, 500)
        : typeof row.attrs["summary"] === "string"
          ? (row.attrs["summary"] as string).slice(0, 500)
          : null;
    const normalizedItemUrl = row.link ? safeNormalize(row.link) : null;
    const hash = dedupeHash(normalizedItemUrl ?? "", row.title);
    const { rows: ins } = await db.query<{ id: string }>(
      sourcesSql.insertItem,
      [
        sourceId,
        row.title.slice(0, 1000),
        row.link,
        normalizedItemUrl,
        hash,
        row.publishedAt,
        excerpt,
        JSON.stringify(row.attrs),
        baseline,
      ],
    );
    if (ins[0]) insertedIds.push(ins[0].id);
  }
  return insertedIds;
}

function safeNormalize(url: string): string | null {
  try {
    return normalizeUrl(url);
  } catch {
    return null;
  }
}

// ── main collect ───────────────────────────────────────

export async function collectSource(
  sourceId: string,
  opts: { manual?: boolean; userId?: string } = {},
): Promise<CollectResult> {
  const db = getDb();
  const { rows: srcRows } = await db.query<Record<string, unknown>>(
    sourcesSql.findById,
    [sourceId],
  );
  const source = srcRows[0] as
    | {
        id: string;
        url: string;
        normalized_url: string;
        kind: string;
        fetch_strategy: string;
        status: string;
        interval_minutes: number;
        fixed_interval: boolean;
        etag: string | null;
        last_modified: string | null;
        feed_url: string | null;
        consecutive_failures: number;
      }
    | undefined;
  if (!source) {
    throw new AppError(errorCodes.SOURCE_NOT_FOUND, "소스를 찾을 수 없습니다.", 404);
  }
  if (source.kind === "link" || source.fetch_strategy === "link") {
    return { runId: "", newCount: 0, result: "unchanged", errorCode: null };
  }

  // 수동 수집 쿨다운
  if (opts.manual && opts.userId) {
    const { rows: last } = await db.query<{ created_at: string }>(
      sourcesSql.lastManualCollect,
      [sourceId],
    );
    if (
      last[0] &&
      Date.now() - new Date(last[0].created_at).getTime() <
        MANUAL_COLLECT_COOLDOWN_MIN * 60_000
    ) {
      throw new AppError(
        errorCodes.RATE_LIMITED,
        "수동 수집은 5분에 한 번만 가능합니다.",
        429,
      );
    }
    await db.query(sourcesSql.insertManualAction, [
      opts.userId,
      sourceId,
      "collect",
    ]);
  }

  if (!(await robotsAllowed(source.normalized_url))) {
    await db.query(sourcesSql.updateAfterRun, [
      sourceId,
      "pause",
      null,
      source.consecutive_failures,
      nextCrawlAt(source.interval_minutes),
      null,
      null,
      null,
      source.interval_minutes,
    ]);
    throw new AppError(
      errorCodes.ROBOTS_DISALLOWED,
      "robots.txt가 이 경로의 수집을 금지합니다.",
      403,
    );
  }

  const started = Date.now();
  let newIds: string[] = [];
  let result: CollectResult["result"] = "ok";
  let runError: { code: string; detail: string } | null = null;
  let newStatus = "ok";
  let failures = 0;
  let lastSuccess: string | null = new Date().toISOString().slice(0, 19).replace("T", " ");
  let etag: string | null = null;
  let lastModified: string | null = null;

  try {
    const page = await fetchPage(source.url, {
      etag: source.etag,
      lastModified: source.last_modified,
    });
    etag = page.etag;
    lastModified = page.lastModified;

    if (page.status === 304) {
      result = "unchanged";
    } else {
      const { rows: specRows } = await db.query<{
        version: number;
        spec: string;
      }>(sourcesSql.latestActiveSpec, [sourceId]);
      const spec = specRows[0]
        ? (JSON.parse(specRows[0].spec) as CrawlSpec)
        : null;

      let extracted = await extractRows(
        source,
        spec,
        page.body,
        page.contentType,
        page.finalUrl,
      );

      // self-repair: 반복된 0건 추출이면 스펙을 재생성해 본다.
      if (
        extracted.length === 0 &&
        source.fetch_strategy === "html" &&
        source.consecutive_failures >= EMPTY_RUNS_BEFORE_REPAIR
      ) {
        const repaired = await repairSpec(sourceId, page.body, page.finalUrl);
        if (repaired) extracted = repaired.rows;
      }

      newIds = await persistItems(sourceId, extracted, false);
      if (newIds.length > 0) {
        await matchNewItemsForSubscribers(sourceId, newIds);
        await clusterItems(newIds);
      }
    }
  } catch (err) {
    result = "error";
    failures = source.consecutive_failures + 1;
    newStatus = failures >= 3 ? "fail" : "warn";
    lastSuccess = null;
    runError = {
      code: err instanceof AppError ? err.code : errorCodes.INTERNAL_ERROR,
      detail: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
    };
  }

  const interval = nextInterval(
    source.interval_minutes,
    newIds.length,
    source.fixed_interval,
  );
  await db.query(sourcesSql.updateAfterRun, [
    sourceId,
    newStatus,
    lastSuccess,
    failures,
    nextCrawlAt(interval),
    etag,
    lastModified,
    null,
    interval,
  ]);

  const durationMs = Date.now() - started;
  const { rows: runRows } = await db.query<{ id: string }>(
    sourcesSql.insertRun,
    [
      sourceId,
      source.fetch_strategy,
      durationMs,
      newIds.length,
      result,
      runError?.code ?? null,
      runError?.detail ?? null,
    ],
  );

  return {
    runId: runRows[0]?.id ?? "",
    newCount: newIds.length,
    result,
    errorCode: runError?.code ?? null,
  };
}

// ── source creation + baseline ─────────────────────────

export async function createSourceWithBaseline(
  userId: string,
  input: {
    url: string;
    displayName: string;
    categoryId: string | null;
    tagNames: string[];
    fields: { key: string; label: string; type: string; role: string; visible: boolean; sortOrder: number }[];
    fetchStrategy: string;
    linkOnly: boolean;
    spec?: CrawlSpec | null;
    previewRows?: ExtractedRow[];
  },
): Promise<{ subscriptionId: string; sourceId: string; baselineCount: number; reusedExisting: boolean }> {
  const db = getDb();
  const normalized = normalizeUrl(input.url);

  if (input.categoryId) {
    const { rows: cat } = await db.query<{ id: string }>(
      `select id from myportal.categories where id = $1 and user_id = $2`,
      [input.categoryId, userId],
    );
    if (!cat[0]) {
      throw new AppError(errorCodes.CATEGORY_NOT_FOUND, "카테고리를 찾을 수 없습니다.", 404);
    }
  }

  return db.transaction(async (tx) => {
    // 공유 소스 재사용: 같은 normalized_url이면 새로 수집하지 않는다.
    const { rows: existing } = await tx.query<{ id: string }>(
      sourcesSql.findByNormalizedUrl,
      [normalized],
    );
    let sourceId: string;
    let reused = false;
    let baselineCount = 0;

    if (existing[0]) {
      sourceId = existing[0].id;
      reused = true;
    } else {
      const kind = input.linkOnly ? "link" : "list";
      const strategy = input.linkOnly ? "link" : input.fetchStrategy;
      const status = input.linkOnly ? "link" : "ok";
      const { rows: ins } = await tx.query<{ id: string }>(
        sourcesSql.insertSource,
        [
          input.url,
          normalized,
          kind,
          strategy,
          status,
          input.spec?.feedUrl ?? null,
          input.displayName.slice(0, 300),
        ],
      );
      sourceId = ins[0].id;

      for (const f of input.fields) {
        await tx.query(sourcesSql.insertField, [
          sourceId,
          f.key,
          f.label,
          f.type,
          f.role,
          f.sortOrder,
          f.visible,
        ]);
      }
      if (input.spec) {
        await tx.query(sourcesSql.insertSpec, [
          sourceId,
          1,
          JSON.stringify(input.spec),
          "heuristic",
        ]);
      }
    }

    const { rows: dup } = await tx.query<{ id: string }>(
      `select id from myportal.subscriptions where user_id = $1 and source_id = $2`,
      [userId, sourceId],
    );
    if (dup[0]) {
      throw new AppError(
        errorCodes.ALREADY_SUBSCRIBED,
        "이미 구독 중인 소스입니다.",
        409,
      );
    }

    const { rows: sub } = await tx.query<{ id: string }>(
      sourcesSql.insertSubscription,
      [userId, sourceId, input.displayName, input.categoryId],
    );
    const subscriptionId = sub[0].id;

    // 태그 생성·연결
    for (const name of input.tagNames) {
      const tagId = await upsertTag(tx, userId, name);
      await tx.query(
        `insert into myportal.subscription_tags (subscription_id, tag_id)
         values ($1, $2) on conflict do nothing`,
        [subscriptionId, tagId],
      );
    }

    // 신규 소스면 기준선 수집: 기존 게시물을 '읽음 처리된 과거 데이터'로 밀어 넣는다.
    if (!reused && !input.linkOnly) {
      baselineCount = await runBaseline(tx, sourceId, input);
      // 기준선 항목은 이 사용자에게 '읽음'으로 표시해 신규 뱃지가 뜨지 않게 한다.
      const { rows: baseItems } = await tx.query<{ id: string }>(
        `select id from myportal.items where source_id = $1 and is_baseline = true`,
        [sourceId],
      );
      for (const it of baseItems) {
        await tx.query(
          `insert into myportal.item_states (user_id, item_id, read, read_at)
           values ($1, $2, true, now())
           on conflict (user_id, item_id) do nothing`,
          [userId, it.id],
        );
      }
    }

    return { subscriptionId, sourceId, baselineCount, reusedExisting: reused };
  });
}

async function upsertTag(
  tx: DatabaseClient,
  userId: string,
  name: string,
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `insert into myportal.tags (user_id, name) values ($1, $2)
     on conflict (user_id, name) do update set name = excluded.name
     returning id`,
    [userId, name.trim()],
  );
  return rows[0].id;
}

async function runBaseline(
  tx: DatabaseClient,
  sourceId: string,
  input: { url: string; fetchStrategy: string; spec?: CrawlSpec | null; previewRows?: ExtractedRow[] },
): Promise<number> {
  let rows: ExtractedRow[] = input.previewRows ?? [];

  if (rows.length === 0) {
    // 분석 시 미리보기가 없으면 라이브 수집으로 기준선을 만든다.
    const page = await fetchPage(input.url);
    if (input.fetchStrategy === "rss" || looksLikeFeed(page.contentType, page.body)) {
      rows = parseFeed(page.body, page.finalUrl);
    } else {
      const jsonLd = parseJsonLdList(page.body, page.finalUrl);
      if (jsonLd) {
        rows = jsonLd;
      } else if (input.spec) {
        rows = applySpec(page.body, input.spec, page.finalUrl);
      } else {
        const gen = generateSpec(page.body, page.finalUrl);
        if (gen) {
          rows = gen.rows;
          await tx.query(sourcesSql.insertSpec, [
            sourceId,
            1,
            JSON.stringify(gen.spec),
            "heuristic",
          ]);
        }
      }
    }
  }

  const slice = rows.slice(0, BASELINE_SIZE);
  let count = 0;
  for (const row of slice) {
    const normalizedItemUrl = row.link ? safeNormalize(row.link) : null;
    const hash = dedupeHash(normalizedItemUrl ?? "", row.title);
    const { rows: ins } = await tx.query<{ id: string }>(sourcesSql.insertItem, [
      sourceId,
      row.title.slice(0, 1000),
      row.link,
      normalizedItemUrl,
      hash,
      row.publishedAt,
      null,
      JSON.stringify(row.attrs),
      true,
    ]);
    if (ins[0]) count++;
  }
  return count;
}
