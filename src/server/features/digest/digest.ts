import type {
  DigestPreview,
  DigestRun,
  DigestSettings,
  Item,
} from "@myportal/api-contracts";
import { getDb } from "../../config/db";
import { env } from "../../config/env";
import { AppError, errorCodes } from "../../errors/error-codes";
import { mapItem, type ItemRow } from "../desk/desk";
import { deskSql } from "../desk/desk.sql";

const sql = {
  settings: `
    select timezone, digest_enabled, digest_frequency, digest_time,
           digest_weekday, digest_categories, digest_limit, digest_sent_at
    from myportal.user_settings where user_id = $1
  `,
  updateSettings: `
    update myportal.user_settings
    set digest_enabled = $2, digest_frequency = $3, digest_time = $4,
        digest_weekday = $5, digest_categories = $6::jsonb, digest_limit = $7,
        timezone = $8
    where user_id = $1
  `,
  history: `
    select id, ran_at, item_count, result
    from myportal.digest_runs
    where user_id = $1
    order by ran_at desc
    limit 20
  `,
  insertRun: `
    insert into myportal.digest_runs (user_id, item_count, result, error_detail, content_html)
    values ($1, $2, $3, $4, $5)
    returning id
  `,
  touchSent: `
    update myportal.user_settings set digest_sent_at = now() where user_id = $1
  `,
  email: `
    select email from myportal.users where id = $1
  `,
  // 지난 24시간의 비-베이스라인 항목 (다이제스트 대상)
  recentItems: `
    select i.id, i.source_id, i.title, i.url, i.published_at, i.collected_at,
           i.excerpt, i.attrs, i.is_baseline, i.cluster_id,
           coalesce(st.read, false) as read,
           coalesce(st.starred, false) as starred,
           rm.rule_id, rm.action as rule_action, kr.name as rule_name,
           s.category_id, s.display_name as source_name, src.status as source_status,
           s.id as subscription_id
    from myportal.items i
    join myportal.subscriptions s
      on s.source_id = i.source_id and s.user_id = $1 and s.paused = false
    join myportal.sources src on src.id = i.source_id
    left join myportal.item_states st
      on st.item_id = i.id and st.user_id = $1
    left join myportal.item_rule_matches rm
      on rm.item_id = i.id and rm.user_id = $1
    left join myportal.keyword_rules kr on kr.id = rm.rule_id
    where i.is_baseline = false
      and i.collected_at > now() - interval '24 hours'
      and coalesce(rm.action, '') <> 'mute'
    order by i.collected_at desc
    limit 500
  `,
  categories: `
    select id, name from myportal.categories where user_id = $1
  `,
};

interface SettingsRow {
  timezone: string;
  digest_enabled: boolean;
  digest_frequency: "daily" | "weekly";
  digest_time: string;
  digest_weekday: number;
  digest_categories: unknown;
  digest_limit: number;
  digest_sent_at: string | null;
}

function toSettings(r: SettingsRow): DigestSettings {
  return {
    enabled: r.digest_enabled,
    frequency: r.digest_frequency,
    time: r.digest_time,
    weekday: r.digest_weekday,
    categories: Array.isArray(r.digest_categories)
      ? r.digest_categories.map(String)
      : typeof r.digest_categories === "string"
        ? (JSON.parse(r.digest_categories) as unknown[]).map(String)
        : [],
    limit: r.digest_limit,
    timezone: r.timezone,
  };
}

async function deadlineMap() {
  const db = getDb();
  const { rows } = await db.query<{ source_id: string; key: string }>(
    deskSql.deadlineFields,
  );
  const m = new Map<string, string>();
  for (const r of rows) m.set(r.source_id, r.key);
  return m;
}

interface DigestItemRow extends ItemRow {
  category_id: string | null;
  source_name: string;
  source_status: string;
  subscription_id: string;
}

export async function getDigest(userId: string): Promise<{
  settings: DigestSettings;
  history: DigestRun[];
  email: string;
}> {
  const db = getDb();
  const [s, h, e] = await Promise.all([
    db.query<SettingsRow>(sql.settings, [userId]),
    db.query<{ id: string; ran_at: string; item_count: number; result: DigestRun["result"] }>(
      sql.history, [userId]),
    db.query<{ email: string }>(sql.email, [userId]),
  ]);
  if (!s.rows[0]) {
    throw new AppError(errorCodes.UNAUTHORIZED, "사용자 설정을 찾을 수 없습니다.", 401);
  }
  return {
    settings: toSettings(s.rows[0]),
    history: h.rows.map((r) => ({
      id: r.id,
      ranAt: new Date(r.ran_at).toISOString(),
      itemCount: r.item_count,
      result: r.result,
    })),
    email: e.rows[0]?.email ?? "",
  };
}

export async function updateDigest(
  userId: string,
  input: DigestSettings,
): Promise<DigestSettings> {
  const db = getDb();
  for (const catId of input.categories) {
    const { rows } = await db.query<{ id: string }>(
      `select id from myportal.categories where id = $1 and user_id = $2`,
      [catId, userId],
    );
    if (!rows[0]) {
      throw new AppError(errorCodes.CATEGORY_NOT_FOUND, "카테고리를 찾을 수 없습니다.", 404);
    }
  }
  await db.query(sql.updateSettings, [
    userId,
    input.enabled,
    input.frequency,
    input.time,
    input.weekday,
    JSON.stringify(input.categories),
    input.limit,
    input.timezone,
  ]);
  return input;
}

// 미리보기 + 실제 발송이 공유하는 다이제스트 조립 로직.
async function buildDigest(userId: string): Promise<{
  preview: DigestPreview;
  items: (Item & { categoryId: string | null; sourceName: string })[];
  settings: DigestSettings;
}> {
  const db = getDb();
  const [itemsRes, settingsRes, catsRes, dlMap] = await Promise.all([
    db.query<DigestItemRow>(sql.recentItems, [userId]),
    db.query<SettingsRow>(sql.settings, [userId]),
    db.query<{ id: string; name: string }>(sql.categories, [userId]),
    deadlineMap(),
  ]);
  const settings = settingsRes.rows[0]
    ? toSettings(settingsRes.rows[0])
    : null;
  if (!settings) {
    throw new AppError(errorCodes.UNAUTHORIZED, "사용자 설정을 찾을 수 없습니다.", 401);
  }

  const catName = new Map(catsRes.rows.map((c) => [c.id, c.name]));
  const allowedCats = new Set(settings.categories);
  const filterByCats = allowedCats.size > 0;

  const items = itemsRes.rows.map((r) => {
    const item = mapItem(r, dlMap);
    return {
      ...item,
      categoryId: r.category_id,
      sourceName: r.source_name,
      sourceStatus: r.source_status,
      subscriptionId: r.subscription_id,
    };
  });
  const inScope = items.filter(
    (i) => !filterByCats || (i.categoryId && allowedCats.has(i.categoryId)),
  );

  const alertItems = inScope.filter((i) => i.ruleMatch?.action === "alert");
  const soon = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const deadlineItems = inScope.filter(
    (i) =>
      i.deadlineAt &&
      new Date(i.deadlineAt).getTime() <= soon &&
      new Date(i.deadlineAt).getTime() >= Date.now(),
  );

  const sections = new Map<string, { name: string; items: typeof inScope }>();
  for (const i of inScope) {
    if (i.ruleMatch?.action === "alert" || deadlineItems.includes(i)) continue;
    const key = i.categoryId ?? "__uncategorized__";
    const name = catName.get(i.categoryId ?? "") ?? "미분류";
    const sec = sections.get(key) ?? { name, items: [] };
    if (sec.items.length < settings.limit) sec.items.push(i);
    sections.set(key, sec);
  }

  const warnSources = new Map<string, { subscriptionId: string; name: string; status: string }>();
  for (const i of items) {
    if (i.sourceStatus === "warn" || i.sourceStatus === "fail") {
      warnSources.set(i.subscriptionId, {
        subscriptionId: i.subscriptionId,
        name: i.sourceName,
        status: i.sourceStatus,
      });
    }
  }

  const preview: DigestPreview = {
    generatedAt: new Date().toISOString(),
    alertItems,
    deadlineItems,
    categorySections: [...sections.entries()].map(([categoryId, s]) => ({
      categoryId: categoryId === "__uncategorized__" ? "" : categoryId,
      name: s.name,
      count: s.items.length,
      topItems: s.items,
    })),
    warnSources: [...warnSources.values()].map((w) => ({
      subscriptionId: w.subscriptionId,
      name: w.name,
      status: w.status as DigestPreview["warnSources"][number]["status"],
    })),
  };

  return { preview, items: inScope, settings };
}

export async function digestPreview(userId: string): Promise<DigestPreview> {
  const { preview } = await buildDigest(userId);
  return preview;
}

function renderDigestHtml(preview: DigestPreview): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let html = `<h2>myportal 다이제스트</h2>`;
  if (preview.alertItems.length) {
    html += `<h3>긴급 알림</h3><ul>`;
    for (const i of preview.alertItems) {
      html += `<li><a href="${esc(i.url ?? "#")}">${esc(i.title)}</a></li>`;
    }
    html += `</ul>`;
  }
  if (preview.deadlineItems.length) {
    html += `<h3>마감 임박</h3><ul>`;
    for (const i of preview.deadlineItems) {
      html += `<li>${esc(i.title)} — 마감 ${esc(i.deadlineAt ?? "")}</li>`;
    }
    html += `</ul>`;
  }
  for (const sec of preview.categorySections) {
    html += `<h3>${esc(sec.name)} (${sec.count})</h3><ul>`;
    for (const i of sec.topItems) {
      html += `<li><a href="${esc(i.url ?? "#")}">${esc(i.title)}</a></li>`;
    }
    html += `</ul>`;
  }
  if (preview.warnSources.length) {
    html += `<h3>수집 상태 경고</h3><ul>`;
    for (const w of preview.warnSources) {
      html += `<li>${esc(w.name)} — ${esc(w.status)}</li>`;
    }
    html += `</ul>`;
  }
  return html;
}

async function sendMail(to: string, subject: string, html: string): Promise<boolean> {
  if (!env.smtpUrl) return false;
  const nodemailer = await import("nodemailer");
  const transport = nodemailer.createTransport(env.smtpUrl);
  await transport.sendMail({
    from: env.mailFrom,
    to,
    subject,
    html,
  });
  return true;
}

export async function sendDigestNow(
  userId: string,
): Promise<{ sent: boolean; itemCount: number }> {
  const db = getDb();
  const { preview, settings } = await buildDigest(userId);
  const itemCount =
    preview.alertItems.length +
    preview.deadlineItems.length +
    preview.categorySections.reduce((n, s) => n + s.topItems.length, 0);

  const { rows: emailRow } = await db.query<{ email: string }>(sql.email, [userId]);
  const to = emailRow[0]?.email;
  const html = renderDigestHtml(preview);

  let result: "ok" | "fail" | "queued" = "queued";
  let detail: string | null = null;
  let sent = false;

  if (to && env.smtpUrl) {
    try {
      sent = await sendMail(to, "myportal 다이제스트", html);
      result = sent ? "ok" : "fail";
    } catch (err) {
      result = "fail";
      detail = err instanceof Error ? err.message.slice(0, 300) : "send failed";
    }
  } else {
    detail = env.smtpUrl ? "no recipient" : "SMTP_URL not configured";
  }

  await db.query(sql.insertRun, [userId, itemCount, result, detail, html]);
  if (sent) await db.query(sql.touchSent, [userId]);
  return { sent, itemCount };
}
