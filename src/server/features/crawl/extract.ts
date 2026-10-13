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
  // 사용자가 지정한 '목록 항목 힌트' — 스펙과 함께 저장돼
  // 스펙 재생성/self-repair 시 같은 영역을 다시 찾는 데 사용한다.
  hint?: string;
  // JS로 목록을 채우는 사이트: 일반 fetch가 아니라 헤드리스 브라우저로
  // 렌더링한 DOM을 파싱한다.
  render?: boolean;
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

// 네비게이션·배너 등 "목록이 아닌" 영역을 식별하는 클래스/id 토큰.
// class·id 값을 [\s_.-]로 나눠 토큰 단위로 비교하므로
// menu-area, ms-mbnr-sd, list-navi 같은 합성 이름에도 매칭된다.
const NOISE_TOKENS = new Set([
  "gnb", "lnb", "snb", "nav", "navi", "navbar", "navigation",
  "menu", "menus", "menubar", "sidebar", "aside",
  "toolbar", "breadcrumb", "breadcrumbs", "paging", "paginate", "pagination",
  "quick", "banner", "banners", "bnr", "mbnr",
  "slider", "sliders", "slide", "slides", "swiper", "carousel", "rolling",
  "visual", "topbar", "util", "utils", "header", "footer",
  "search", "cate", "login", "join", "share", "sns",
]);

// 앵커 안 장식용(배지/아이콘) 자식의 텍스트는 제목에서 제외하는 토큰.
// 예: <a>공모전명 <span class="stat spec">SPECIAL</span></a>
const BADGE_TOKENS = new Set([
  "badge", "badges", "stat", "stats", "ico", "icon", "icons",
  "flag", "flags", "sticker", "stickers", "chip", "chips",
  "label", "labels", "mark", "new", "hot",
]);

function hasToken(el: Element, tokens: Set<string>): boolean {
  const attr = `${el.getAttribute("class") ?? ""} ${el.getAttribute("id") ?? ""}`;
  for (const tok of attr.toLowerCase().split(/[\s_.-]+/)) {
    if (tok && tokens.has(tok.replace(/\d+$/, ""))) return true;
  }
  return false;
}

interface Bucket {
  itemSelector: string;
  elements: Element[];
  titleLen: number;
}

// 앵커 없이 JS 클릭으로 이동하는 목록 항목의 식별 신호.
// 예: <tr class="contentitem" style="cursor:pointer" data-contest_pk="...">
function isClickableItem(el: Element): boolean {
  const style = el.getAttribute("style") ?? "";
  if (/cursor\s*:\s*pointer/i.test(style)) return true;
  if (el.hasAttribute("onclick")) return true;
  const role = el.getAttribute("role") ?? "";
  if (role === "button" || role === "link") return true;
  if (el.hasAttribute("tabindex")) return true;
  return ["data-href", "data-url", "data-link", "data-goto", "data-target"].some(
    (a) => el.hasAttribute(a),
  );
}

const TITLE_HINT_TOKENS = new Set([
  "tit", "title", "subject", "name", "heading", "txt",
]);

// 앵커가 없는 항목에서 제목 후보 텍스트를 고른다.
// class/id에 tit/title/subject 계열 토큰이 있는 요소를 우선하고,
// 없으면 제목 태그(h1-h6, strong, b) 중 가장 긴 텍스트를 쓴다.
function pickTitleText(el: Element): string {
  let best = "";
  for (const c of el.querySelectorAll("[class],[id]")) {
    if (!hasToken(c, TITLE_HINT_TOKENS) || hasToken(c, BADGE_TOKENS)) continue;
    const t = (c.textContent ?? "").replace(/\s+/g, " ").trim();
    if (t.length > best.length) best = t;
  }
  if (best.length < 6) {
    for (const c of el.querySelectorAll("h1,h2,h3,h4,h5,h6,strong,b")) {
      const t = (c.textContent ?? "").replace(/\s+/g, " ").trim();
      if (t.length > best.length) best = t;
    }
  }
  return best.length >= 6 ? best.slice(0, 300) : "";
}

function buildBuckets(document: Document, anchorless: boolean): Map<string, Bucket> {
  const buckets = new Map<string, Bucket>();
  for (const el of document.querySelectorAll(ITEM_TAGS)) {
    const anchor = pickMainAnchor(el);
    let titleLen = 0;
    if (anchor) {
      titleLen = anchorTitle(anchor).length;
    } else if (anchorless && isClickableItem(el)) {
      titleLen = pickTitleText(el).length;
    }
    if (titleLen === 0) continue;
    const parent = el.parentElement;
    if (!parent) continue;
    const itemSelector = `${parentSelector(parent)} > ${el.tagName.toLowerCase()}`;
    let bucket = buckets.get(itemSelector);
    if (!bucket) {
      bucket = { itemSelector, elements: [], titleLen: 0 };
      buckets.set(itemSelector, bucket);
    }
    bucket.elements.push(el);
    bucket.titleLen += titleLen;
  }
  return buckets;
}

function evaluateBuckets(
  document: Document,
  buckets: Map<string, Bucket>,
  pageUrl: string,
  hint: string | undefined,
  linkTemplates: Map<string, string>,
): { spec: CrawlSpec; rows: ExtractedRow[]; hintMatched: boolean } | null {
  // 점수 = 항목 수 × 평균 제목 길이(상한 40).
  // 개수만 비교하면 사이드바 카테고리 메뉴처럼 "짧은 라벨이 많이 반복되는"
  // 네비게이션이 본문 목록보다 높게 평가되는 문제가 있다.
  const ranked = [...buckets.values()]
    .filter((b) => b.elements.length >= 3)
    .sort((a, b) => bucketScore(b) - bucketScore(a));

  const hinted = hint ? findHintedBucket(document, buckets, hint) : null;
  const ordered = hinted
    ? [hinted, ...ranked.filter((b) => b !== hinted)]
    : ranked;

  for (const bucket of ordered) {
    const spec: CrawlSpec = {
      strategy: "html",
      itemSelector: bucket.itemSelector,
      fields: {},
    };
    const rows = applyDomSpec(document, spec, pageUrl, linkTemplates);
    if (rows.length >= 3) {
      if (hint) spec.hint = hint;
      return { spec, rows, hintMatched: bucket === hinted };
    }
  }
  return null;
}

// 목록 패턴: 같은 부모 아래 같은 태그의 자식이 3개 이상 반복되면 목록으로 본다.
// 아이템은 클래스가 아닌 태그명으로 묶는다 — li.top/li.bg처럼
// 클래스 변형으로 같은 목록이 여러 버킷으로 쪼개지는 것을 방지하기 위함.
// hint가 주어지면 그 문자열을 포함하는 버킷을 먼저 시도한다.
// 1차 패스는 링크를 가진 항목만 본다(기존 동작). 매칭이 없으면 2차 패스에서
// cursor:pointer/onclick 같은 JS 클릭 목록(앵커 없는 항목)도 허용한다.
export function generateSpec(
  html: string,
  pageUrl: string,
  hint?: string,
): { spec: CrawlSpec; rows: ExtractedRow[]; hintMatched: boolean } | null {
  const { document } = parseHTML(html);
  stripNoise(document);
  const linkTemplates = collectLinkTemplates(html);

  const strict = evaluateBuckets(
    document,
    buildBuckets(document, false),
    pageUrl,
    hint,
    linkTemplates,
  );
  if (strict && (!hint || strict.hintMatched)) return strict;

  const loose = evaluateBuckets(
    document,
    buildBuckets(document, true),
    pageUrl,
    hint,
    linkTemplates,
  );
  if (loose && (!hint || loose.hintMatched)) return loose;
  return strict ?? loose;
}

// 힌트 문자열을 포함하는 가장 안쪽 요소를 찾아,
// 그 요소의 조상 중 버킷 아이템에 해당하는 가장 가까운 버킷을 반환한다.
// contains로 비교하면 body > div 같은 페이지 래퍼가 먼저 걸리므로
// 조상 체인에서 첫 번째로 등장하는 아이템 요소를 선택해야 한다.
function findHintedBucket(
  document: Document,
  buckets: Map<string, Bucket>,
  hint: string,
): Bucket | null {
  const needle = hint.replace(/\s+/g, " ").trim();
  if (needle.length < 2) return null;
  // 가장 안쪽(깊은) 요소가 항목 내부를 가장 정확히 가리킨다.
  let best: Element | null = null;
  let bestDepth = -1;
  for (const el of document.querySelectorAll("*")) {
    const t = (el.textContent ?? "").replace(/\s+/g, " ");
    if (!t.includes(needle)) continue;
    let depth = 0;
    for (let p = el.parentElement; p; p = p.parentElement) depth++;
    if (depth > bestDepth) {
      bestDepth = depth;
      best = el;
    }
  }
  if (!best) return null;
  const owner = new Map<Element, Bucket>();
  for (const bucket of buckets.values()) {
    for (const el of bucket.elements) owner.set(el, bucket);
  }
  // 힌트 요소의 조상은 여러 버킷에 속할 수 있다 — 예: a < div.tit < li.
  // li.bg > div(필드 단위)보다 ul.list > li(행 단위)가 넓은 목록이므로
  // 조상 체인에 걸린 모든 버킷 중 점수(항목 수 × 평균 제목 길이)가
  // 가장 높은 것을 고른다.
  let picked: Bucket | null = null;
  for (let node: Element | null = best; node; node = node.parentElement) {
    const bucket = owner.get(node);
    if (bucket && (!picked || bucketScore(bucket) > bucketScore(picked))) {
      picked = bucket;
    }
  }
  return picked;
}

function bucketScore(b: Bucket): number {
  return b.elements.length * Math.min(b.titleLen / b.elements.length, 40);
}

function stripNoise(document: Document): void {
  for (const sel of [
    "script",
    "style",
    "noscript",
    "template",
    "iframe",
    "nav",
    "header",
    "footer",
    "aside",
    "form",
    "[role='navigation']",
    "[role='banner']",
    "[role='contentinfo']",
    "[role='search']",
    "[aria-hidden='true']",
  ]) {
    for (const el of document.querySelectorAll(sel)) el.remove();
  }
  // nav/menu/banner 계열 클래스나 id를 가진 컨테이너 제거
  for (const el of [...document.querySelectorAll("[class],[id]")]) {
    if (hasToken(el, NOISE_TOKENS)) el.remove();
  }
}

// 앵커의 제목 텍스트. 배지/아이콘 계열 자식 요소의 텍스트는 제외한다.
function anchorTitle(a: HTMLAnchorElement): string {
  let out = "";
  const walk = (node: ChildNode) => {
    if (node.nodeType === 3) {
      out += node.textContent ?? "";
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    if (hasToken(el, BADGE_TOKENS)) return;
    for (const c of el.childNodes) walk(c);
  };
  for (const c of a.childNodes) walk(c);
  return out.replace(/\s+/g, " ").trim();
}

// 요소 안에서 '목록 항목 제목'처럼 보이는 주요 앵커 하나를 고른다.
function pickMainAnchor(el: Element): HTMLAnchorElement | null {
  let best: HTMLAnchorElement | null = null;
  let bestLen = 0;
  for (const a of el.querySelectorAll("a[href]")) {
    const t = anchorTitle(a as HTMLAnchorElement);
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

function selectorFor(el: Element): string {
  const cls = (el.getAttribute("class") ?? "").trim().split(/\s+/)[0];
  return cls ? `${el.tagName.toLowerCase()}.${cssEscape(cls)}` : el.tagName.toLowerCase();
}

// 클래스/id가 없는 범용 태그(예: 그냥 ul)는 셀렉터가 너무 넓어지므로
// 가장 가까운 식별 가능한 조상으로 한정한다.
function parentSelector(el: Element): string {
  const id = el.getAttribute("id");
  if (id) return `#${cssEscape(id)}`;
  const sel = selectorFor(el);
  if (sel.includes(".")) return sel;
  let anc = el.parentElement;
  while (anc) {
    const aid = anc.getAttribute("id");
    if (aid) return `#${cssEscape(aid)} ${sel}`;
    const c = (anc.getAttribute("class") ?? "").trim().split(/\s+/)[0];
    if (c) return `${anc.tagName.toLowerCase()}.${cssEscape(c)} ${sel}`;
    anc = anc.parentElement;
  }
  return sel;
}

function cssEscape(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

// ── 스펙 적용 ───────────────────────────────────────────

// 페이지 안의 쿼리스트링 URL에서 "파라미터명 → URL 템플릿"을 모은다.
// JS 클릭 목록은 항목 키를 data-* 속성에만 담고 있는 경우가 많은데
// (예: data-contest_pk="111834"), 페이지 어딘가에 view.do?contest_pk=…
// 형태의 URL이 있으면 그 템플릿에 키를 대입해 상세 링크를 복원할 수 있다.
function collectLinkTemplates(html: string): Map<string, string> {
  const map = new Map<string, string>();
  const score = (u: string) =>
    /view|read|detail|show|content|item|article|post|board|notice|story/i.test(u)
      ? 2
      : 1;
  const scores = new Map<string, number>();
  for (const m of html.matchAll(
    /["']((?:https?:\/\/|\/)[^"'<>\s]+\?[^"'<>\s]+)["']/g,
  )) {
    const url = m[1];
    const q = url.indexOf("?");
    for (const kv of url.slice(q + 1).split("&")) {
      const eq = kv.indexOf("=");
      if (eq <= 0) continue;
      const name = kv.slice(0, eq);
      if (!name || name.length > 40) continue;
      const s = score(url);
      if ((scores.get(name) ?? 0) < s) {
        scores.set(name, s);
        map.set(name, url);
      }
    }
  }
  return map;
}

// 앵커가 없는 항목의 링크를 복원한다.
// 우선순위: data-*/onclick에 든 URL → data-* 키의 URL 템플릿 대입.
function deriveItemLink(
  el: Element,
  linkTemplates: Map<string, string>,
  pageUrl: string,
): string | null {
  for (const name of el.getAttributeNames()) {
    const v = (el.getAttribute(name) ?? "").trim();
    if (/^https?:\/\//i.test(v) || v.startsWith("/")) {
      const abs = absolutize(v, pageUrl);
      if (abs) return abs;
    }
  }
  const onclick = el.getAttribute("onclick") ?? "";
  const om = onclick.match(
    /(?:location\.href|location|window\.open)\s*[=(]\s*['"]([^'"]+)['"]/,
  );
  if (om) {
    const abs = absolutize(om[1], pageUrl);
    if (abs) return abs;
  }
  for (const name of el.getAttributeNames()) {
    if (!name.startsWith("data-")) continue;
    const tpl = linkTemplates.get(name.slice(5));
    if (!tpl) continue;
    const v = (el.getAttribute(name) ?? "").trim();
    if (!v || v.length > 60) continue;
    const q = tpl.indexOf("?");
    const rebuilt =
      tpl.slice(0, q + 1) +
      tpl
        .slice(q + 1)
        .split("&")
        .map((kv) => {
          const eq = kv.indexOf("=");
          return eq > 0 && kv.slice(0, eq) === name.slice(5)
            ? `${kv.slice(0, eq)}=${encodeURIComponent(v)}`
            : kv;
        })
        .join("&");
    const abs = absolutize(rebuilt, pageUrl);
    if (abs) return abs;
  }
  return null;
}

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
  linkTemplates: Map<string, string>,
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
    let title: string;
    let link: string | null;
    if (anchor) {
      title = anchorTitle(anchor);
      link = absolutize(anchor.getAttribute("href") ?? "", pageUrl);
    } else {
      // 앵커 없는 JS 클릭 목록 항목 — 제목 후보와 data-* 기반 링크 복원.
      title = pickTitleText(el);
      if (!title) continue;
      link = deriveItemLink(el, linkTemplates, pageUrl);
    }
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
  return applyDomSpec(document, spec, pageUrl, collectLinkTemplates(html));
}
