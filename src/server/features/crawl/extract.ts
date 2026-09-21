import { DOMParser, parseHTML } from "linkedom";
import { absolutize } from "./url";

// ── 스펙 타입 (crawl_specs.spec jsonb에 저장되는 형태) ──

export interface FieldSelector {
  selector: string;
  attr?: string;
}

export interface CrawlSpec {
  strategy: "rss" | "structured" | "html";
  feedUrl?: string;
  itemSelector?: string;
  fields?: Record<string, FieldSelector>;
}

export interface ExtractedRow {
  title: string;
  link: string | null;
  publishedAt: string | null;
  attrs: Record<string, unknown>;
}

// ── RSS / Atom ──────────────────────────────────────────

function text(el: Element | null): string {
  return el?.textContent?.trim() ?? "";
}

export function looksLikeFeed(contentType: string, body: string): boolean {
  if (/rss|atom|xml/i.test(contentType)) return true;
  const head = body.slice(0, 400);
  return /<(\?xml|rss|feed|rdf)/i.test(head);
}

export function parseFeed(xml: string, baseUrl: string): ExtractedRow[] {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const rows: ExtractedRow[] = [];

  const items = doc.querySelectorAll("item");
  if (items.length > 0) {
    for (const it of items) {
      const title = text(it.querySelector("title"));
      const linkRaw =
        text(it.querySelector("link")) ||
        it.querySelector("guid")?.textContent?.trim() ||
        "";
      const date =
        text(it.querySelector("pubDate")) ||
        text(it.querySelector("date")) ||
        text(it.querySelector("[id*='date' i]")) ||
        "";
      const desc = text(it.querySelector("description")).slice(0, 500);
      if (!title) continue;
      rows.push({
        title,
        link: absolutize(linkRaw, baseUrl),
        publishedAt: parseDate(date),
        attrs: desc ? { description: desc } : {},
      });
    }
    return rows;
  }

  const entries = doc.querySelectorAll("entry");
  for (const en of entries) {
    const title = text(en.querySelector("title"));
    const linkEl =
      en.querySelector("link[rel='alternate']") ?? en.querySelector("link");
    const linkRaw = linkEl?.getAttribute("href") ?? text(linkEl);
    const date =
      text(en.querySelector("published")) ||
      text(en.querySelector("updated")) ||
      "";
    const summary = text(en.querySelector("summary")).slice(0, 500);
    if (!title) continue;
    rows.push({
      title,
      link: absolutize(linkRaw, baseUrl),
      publishedAt: parseDate(date),
      attrs: summary ? { summary } : {},
    });
  }
  return rows;
}

export function discoverFeedUrl(html: string, baseUrl: string): string | null {
  const { document } = parseHTML(html);
  const links = document.querySelectorAll(
    "link[rel='alternate'][type*='rss'], link[rel='alternate'][type*='atom'], link[rel='alternate'][type*='xml']",
  );
  for (const l of links) {
    const href = l.getAttribute("href");
    if (href) return absolutize(href, baseUrl);
  }
  return null;
}

// ── JSON-LD (ItemList) ──────────────────────────────────

export function parseJsonLdList(
  html: string,
  baseUrl: string,
): ExtractedRow[] | null {
  const { document } = parseHTML(html);
  const scripts = document.querySelectorAll(
    "script[type='application/ld+json']",
  );
  for (const s of scripts) {
    let data: unknown;
    try {
      data = JSON.parse(s.textContent ?? "");
    } catch {
      continue;
    }
    const nodes = Array.isArray(data) ? data : [data];
    for (const node of nodes) {
      const rows = extractItemList(node, baseUrl);
      if (rows && rows.length >= 3) return rows;
      const graph = (node as { "@graph"?: unknown[] })?.["@graph"];
      if (Array.isArray(graph)) {
        for (const g of graph) {
          const r = extractItemList(g, baseUrl);
          if (r && r.length >= 3) return r;
        }
      }
    }
  }
  return null;
}

function extractItemList(
  node: unknown,
  baseUrl: string,
): ExtractedRow[] | null {
  if (!node || typeof node !== "object") return null;
  const n = node as Record<string, unknown>;
  const elements = n["itemListElement"];
  if (!Array.isArray(elements)) return null;
  const rows: ExtractedRow[] = [];
  for (const el of elements) {
    const item = (el as Record<string, unknown>)?.["item"] ?? el;
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, unknown>;
    const title = String(it["name"] ?? it["headline"] ?? "").trim();
    const url = String(it["url"] ?? "").trim();
    const date = String(
      it["datePublished"] ?? it["uploadDate"] ?? "",
    ).trim();
    if (!title) continue;
    rows.push({
      title,
      link: url ? absolutize(url, baseUrl) : null,
      publishedAt: parseDate(date),
      attrs: {},
    });
  }
  return rows.length ? rows : null;
}

// ── DOM 휴리스틱 스펙 생성 ──────────────────────────────

const ITEM_TAGS = "li, article, tr, dd, div, p";

interface Bucket {
  signature: string;
  itemSelector: string;
  elements: Element[];
}

// 목록 패턴: 같은 부모 아래 같은 태그의 자식이 3개 이상 반복되고
// 각 자식이 링크를 포함하면 목록으로 본다.
export function generateSpec(
  html: string,
  pageUrl: string,
): { spec: CrawlSpec; rows: ExtractedRow[] } | null {
  const { document } = parseHTML(html);
  stripNoise(document);

  const buckets = new Map<string, Bucket>();
  for (const el of document.querySelectorAll(ITEM_TAGS)) {
    const anchor = pickMainAnchor(el);
    if (!anchor) continue;
    const parent = el.parentElement;
    if (!parent) continue;
    const signature = `${parentTagKey(parent)} > ${tagKey(el)}`;
    const itemSelector = `${parentSelector(parent)} > ${selectorFor(el)}`;
    let bucket = buckets.get(signature);
    if (!bucket) {
      bucket = { signature, itemSelector, elements: [] };
      buckets.set(signature, bucket);
    }
    bucket.elements.push(el);
  }

  const ranked = [...buckets.values()]
    .filter((b) => b.elements.length >= 3)
    .sort((a, b) => b.elements.length - a.elements.length);

  for (const bucket of ranked) {
    const spec: CrawlSpec = {
      strategy: "html",
      itemSelector: bucket.itemSelector,
      fields: {},
    };
    const rows = applyDomSpec(document, spec, pageUrl);
    if (rows.length >= 3) return { spec, rows };
  }
  return null;
}

function stripNoise(document: Document): void {
  for (const sel of [
    "script",
    "style",
    "noscript",
    "header nav",
    "footer",
    "[role='navigation']",
    "[aria-hidden='true']",
  ]) {
    for (const el of document.querySelectorAll(sel)) el.remove();
  }
}

// 요소 안에서 '목록 항목 제목'처럼 보이는 주요 앵커 하나를 고른다.
function pickMainAnchor(el: Element): HTMLAnchorElement | null {
  let best: HTMLAnchorElement | null = null;
  let bestLen = 0;
  for (const a of el.querySelectorAll("a[href]")) {
    const t = a.textContent?.trim() ?? "";
    if (t.length > bestLen) {
      best = a as HTMLAnchorElement;
      bestLen = t.length;
    }
  }
  if (!best || bestLen < 6) return null;
  const href = best.getAttribute("href") ?? "";
  if (/^(javascript:|#|mailto:)/i.test(href)) return null;
  return best;
}

function tagKey(el: Element): string {
  const cls = (el.getAttribute("class") ?? "").trim().split(/\s+/)[0];
  return cls ? `${el.tagName.toLowerCase()}.${cls}` : el.tagName.toLowerCase();
}

function parentTagKey(el: Element): string {
  return tagKey(el);
}

function selectorFor(el: Element): string {
  const cls = (el.getAttribute("class") ?? "").trim().split(/\s+/)[0];
  return cls ? `${el.tagName.toLowerCase()}.${cssEscape(cls)}` : el.tagName.toLowerCase();
}

function parentSelector(el: Element): string {
  const id = el.getAttribute("id");
  if (id) return `#${cssEscape(id)}`;
  return selectorFor(el);
}

function cssEscape(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

// ── 스펙 적용 ───────────────────────────────────────────

const DATE_RE =
  /(\d{4})[-./년](\d{1,2})[-./월](\d{1,2})|(\d{1,2})[-./](\d{1,2})[-./](\d{4})/;

export function parseDate(raw: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const direct = Date.parse(trimmed);
  if (!Number.isNaN(direct)) return new Date(direct).toISOString();
  const m = trimmed.match(DATE_RE);
  if (m) {
    if (m[1]) {
      const d = new Date(
        Number(m[1]),
        Number(m[2]) - 1,
        Number(m[3]),
      );
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    } else if (m[4]) {
      const d = new Date(
        Number(m[6]),
        Number(m[4]) - 1,
        Number(m[5]),
      );
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
  }
  return null;
}


function applyDomSpec(
  document: Document,
  spec: CrawlSpec,
  pageUrl: string,
): ExtractedRow[] {
  if (!spec.itemSelector) return [];
  let items: Element[];
  try {
    items = [...document.querySelectorAll(spec.itemSelector)];
  } catch {
    return [];
  }
  const rows: ExtractedRow[] = [];
  for (const el of items.slice(0, 100)) {
    const anchor = pickMainAnchor(el);
    if (!anchor) continue;
    const title = anchor.textContent?.trim() ?? "";
    const link = absolutize(anchor.getAttribute("href") ?? "", pageUrl);
    const timeEl = el.querySelector("time");
    const dateRaw =
      timeEl?.getAttribute("datetime") ??
      timeEl?.textContent ??
      el.textContent ??
      "";
    const publishedAt = parseDate(dateRaw);
    const attrs: Record<string, unknown> = {};
    // 스펙의 추가 필드 적용
    for (const [key, fs] of Object.entries(spec.fields ?? {})) {
      if (key === "title" || key === "link" || key === "published") continue;
      const target = el.querySelector(fs.selector);
      const v = fs.attr
        ? target?.getAttribute(fs.attr)
        : target?.textContent?.trim();
      if (v) attrs[key] = v;
    }
    rows.push({ title, link, publishedAt, attrs });
  }
  return rows;
}

// 저장된 스펙으로 페이지에서 목록을 추출한다.
export function applySpec(
  html: string,
  spec: CrawlSpec,
  pageUrl: string,
): ExtractedRow[] {
  const { document } = parseHTML(html);
  stripNoise(document);
  return applyDomSpec(document, spec, pageUrl);
}
