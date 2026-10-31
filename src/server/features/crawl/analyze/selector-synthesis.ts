import type { FieldRole, FieldType } from "@myportal/api-contracts";
import { commonSelector, parentSelector, relativeSelector } from "../dom-selector";
import { SELF_TITLE_SELECTOR, type CrawlSpec, type FieldSelector } from "../extract";
import { absolutize } from "../url";
import type { PageReadResult } from "./llm-read";
import type { PageOutline } from "./page-outline";

// LLM이 [n] 번호로 가리킨 노드들의 조상 체인에서 추출 셀렉터를 역산한다.
// LLM은 읽기만 하고 셀렉터는 이 모듈이 만든다. 순수 함수이며 외부 호출이 없다.
//
// 모든 DOM 조작은 outline.document 위에서 한다. refs의 요소가 그 인스턴스 소속이고,
// 그 문서는 applySpec이 보는 문서와 같은 구조라서 여기서 통과한 셀렉터는 수집에서도
// 같은 요소를 집는다. html을 다시 파싱하면 ref가 무의미해진다.

export interface SynthesisResult {
  spec: CrawlSpec;
  // 합성 과정에서 버린 것 — 분석 단계 detail과 테스트에 쓴다.
  dropped: { key: string; reason: string }[];
  // ref가 어긋나 값 매칭으로 복구한 횟수
  remapped: number;
}

// 항목 루트는 서로 다른 두 제목의 조상이 갈라지는 지점에서 정한다. 그러려면 둘이 필요하다.
const MIN_RESOLVED_ITEMS = 2;
// 첫 두 제목으로 정한 루트 구조를 세 번째 제목이 교차 검증한다.
const CROSS_CHECK_INDEX = 2;

// applyDomSpec이 고정 컬럼으로 직접 처리하므로 attrs 필드로 둘 수 없는 이름.
const RESERVED_KEYS: ReadonlySet<string> = new Set(["title", "link", "published"]);
// titleRef/linkRef로만 보고하는 역할. published는 publishedSelector로 승격하므로 여기 없다.
const REPORTED_ELSEWHERE_ROLES: ReadonlySet<FieldRole> = new Set(["title", "link"]);

type ReadItem = PageReadResult["items"][number];

interface Dropped {
  key: string;
  reason: string;
}

interface Context {
  outline: PageOutline;
  dropped: Dropped[];
  remapped: number;
  // 값 재탐색이 필드마다 일어나므로 문서 단위로 한 번만 만든다.
  index?: DocumentIndex;
}

interface DocumentIndex {
  order: Element[];
  position: Map<Element, number>;
  // 정규화한 텍스트. 요소마다 textContent를 다시 정규화하면 재탐색 한 번이 문서 전체 스캔이다.
  texts: Map<Element, string>;
}

interface ResolvedField {
  key: string;
  label: string;
  type: FieldType;
  role: FieldRole;
  el: Element;
}

interface ResolvedItem {
  index: number;
  title: Element;
  // linkRef가 가리킨 요소. 없으면 제목 주변의 앵커를 쓴다.
  linkEl: Element | null;
  fields: ResolvedField[];
}

interface LocatedItem {
  root: Element;
  item: ResolvedItem;
}

interface Sample {
  root: Element;
  el: Element;
}

// 같은 사유가 항목마다 반복되므로 (key, reason)이 같으면 한 번만 남긴다.
function drop(ctx: Context, key: string, reason: string): void {
  if (!ctx.dropped.some((d) => d.key === key && d.reason === reason)) {
    ctx.dropped.push({ key, reason });
  }
}

// ── 1단계: ref 해소 ──

function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

// 이미지는 textContent가 비므로 개요가 보여 준 alt를 텍스트로 본다.
function elementText(el: Element): string {
  if (el.tagName.toLowerCase() === "img") return el.getAttribute("alt") ?? "";
  return el.textContent ?? "";
}

// 방향은 요소 ⊇ LLM 텍스트만 인정한다. 반대 방향을 허용하면 한 칸 밀린 짧은 요소("2")가
// 긴 텍스트("2026년 …")에 포함되어 어긋난 ref가 통과한다.
function textMatches(el: Element, text: string): boolean {
  const want = normalizeText(text);
  return want === "" || normalizeText(elementText(el)).includes(want);
}

function documentIndex(ctx: Context): DocumentIndex {
  if (ctx.index) return ctx.index;
  const order = [...ctx.outline.document.querySelectorAll("*")].filter((el) => el.closest("head") === null);
  ctx.index = {
    order,
    position: new Map(order.map((el, i) => [el, i])),
    texts: new Map(order.map((el) => [el, normalizeText(elementText(el))])),
  };
  return ctx.index;
}

// 값을 포함하는 가장 안쪽 요소 중 원래 ref 요소와 문서 순서상 가장 가까운 것.
// 같은 값(예: "접수중")이 여러 항목에 있어도 모델이 가리키려던 근처 항목을 고른다.
function findNearestByText(ctx: Context, text: string, near: Element): Element | null {
  const want = normalizeText(text);
  if (want === "") return null;

  const { order, position, texts } = documentIndex(ctx);
  const hits = new Set(order.filter((el) => texts.get(el)?.includes(want)));
  const innermost = order.filter((el) => hits.has(el) && ![...el.children].some((c) => hits.has(c)));
  if (innermost.length === 0) return null;

  const origin = position.get(near) ?? 0;
  const distance = (el: Element): number => Math.abs((position.get(el) ?? 0) - origin);
  return innermost.reduce((best, el) => (distance(el) < distance(best) ? el : best));
}

function resolveRef(ctx: Context, ref: number, text: string, key: string): Element | null {
  const el = ctx.outline.refs[ref] ?? null;
  if (!el) {
    drop(ctx, key, `ref ${ref}가 개요 번호 범위 밖이다`);
    return null;
  }
  if (textMatches(el, text)) return el;

  const found = findNearestByText(ctx, text, el);
  if (!found) {
    drop(ctx, key, `ref ${ref}의 텍스트가 보고한 값과 다르고 값으로도 찾지 못했다`);
    return null;
  }
  ctx.remapped += 1;
  return found;
}

// 7단계: 고정 역할과 충돌하는 필드를 해소 전에 거른다(remapped를 헛되이 세지 않도록).
function reservedReason(field: ReadItem["fields"][number]): string | null {
  if (REPORTED_ELSEWHERE_ROLES.has(field.role)) {
    return `role ${field.role}은 titleRef/linkRef로 보고하는 고정 역할이다`;
  }
  // 게시일은 attrs가 아니라 publishedSelector로 승격한다.
  if (field.role === "published") return null;
  if (RESERVED_KEYS.has(field.key)) return `key ${field.key}는 고정 컬럼 이름이다`;
  return null;
}

function resolveFields(ctx: Context, item: ReadItem, title: Element, linkEl: Element | null): ResolvedField[] {
  // 같은 노드를 두 번 보고하면 같은 값이 두 필드로 갈라진다. 먼저 보고한 것만 채택한다.
  const claimedBy = new Map<Element, string>([[title, "title"]]);
  if (linkEl) claimedBy.set(linkEl, "link");
  const keys = new Set<string>();
  const fields: ResolvedField[] = [];

  for (const field of item.fields) {
    const reserved = reservedReason(field);
    if (reserved) {
      drop(ctx, field.key, reserved);
      continue;
    }
    if (keys.has(field.key)) {
      drop(ctx, field.key, "한 항목 안에서 key가 중복되어 첫 번째만 채택했다");
      continue;
    }
    const el = resolveRef(ctx, field.ref, field.text, field.key);
    if (!el) continue;
    const owner = claimedBy.get(el);
    if (owner) {
      drop(ctx, field.key, `${owner}와 같은 노드를 가리켜 첫 번째만 채택했다`);
      continue;
    }
    keys.add(field.key);
    claimedBy.set(el, field.key);
    fields.push({ key: field.key, label: field.label, type: field.type, role: field.role, el });
  }
  return fields;
}

function resolveItem(ctx: Context, item: ReadItem, index: number): ResolvedItem | null {
  const title = resolveRef(ctx, item.titleRef, item.titleText, `items[${index}].title`);
  if (!title) return null;
  // linkRef에는 텍스트가 없어 값 검증을 못 한다. 범위 밖이면 제목 주변 앵커로 대체한다.
  const linkEl = item.linkRef === undefined ? null : (ctx.outline.refs[item.linkRef] ?? null);
  return { index, title, linkEl, fields: resolveFields(ctx, item, title, linkEl) };
}

// ── 2단계: 항목 루트 ──

function ancestorChain(el: Element): Element[] {
  const chain: Element[] = [];
  for (let cur: Element | null = el; cur; cur = cur.parentElement) chain.push(cur);
  return chain;
}

interface RootPair {
  common: Element;
  first: Element;
  second: Element;
}

// 체인에서 공통 조상 C가 있어야 하는 최소 위치. 제목이 C의 직계면 제목 자신이 루트인데,
// 그것이 항목 컨테이너라는 증거(같은 항목의 다른 필드를 품고 있음)가 있을 때만 허용한다.
// 증거 없이 허용하면 한 부모 아래 나란한 앵커 두 개가 "항목 두 개"로 둔갑한다.
const MIN_INDEX_PLAIN = 2;
const MIN_INDEX_CONTAINER = 1;

function minCommonIndex(isContainer: boolean): number {
  return isContainer ? MIN_INDEX_CONTAINER : MIN_INDEX_PLAIN;
}

// 두 제목의 조상 체인이 처음 만나는 공통 조상 C와, 각 제목 쪽에서 C 바로 아래 요소.
// 제목이 C 자신이거나 증거 없는 직계면 항목 경계를 알 수 없어 null이다.
function splitAtCommonAncestor(a: Element, b: Element, aContainer: boolean, bContainer: boolean): RootPair | null {
  const chainA = ancestorChain(a);
  const chainB = ancestorChain(b);
  const ancestorsOfB = new Set(chainB);
  const ia = chainA.findIndex((el) => ancestorsOfB.has(el));
  if (ia < minCommonIndex(aContainer)) return null;
  const common = chainA[ia];
  const ib = chainB.indexOf(common);
  if (ib < minCommonIndex(bContainer)) return null;
  return { common, first: chainA[ia - 1], second: chainB[ib - 1] };
}

// 세 번째 이후 제목의 루트. C 아래에 있으면 C 바로 아래 요소다.
// 그리드가 행으로 감싸져 C 밖(다른 행)에 있으면 첫 항목과 같은 높이·태그의 조상을 쓴다.
function rootBeyondPair(pair: RootPair, firstTitle: Element, title: Element, isContainer: boolean): Element | null {
  const chain = ancestorChain(title);
  const ic = chain.indexOf(pair.common);
  if (ic >= minCommonIndex(isContainer)) return chain[ic - 1];
  if (ic >= 0) return null;

  const height = ancestorChain(firstTitle).indexOf(pair.first);
  const candidate = chain[height];
  return candidate && candidate.tagName === pair.first.tagName ? candidate : null;
}

// titleEls와 같은 순서의 항목 루트. contents[i]는 i번째 항목의 다른 필드·링크 요소로,
// 제목 요소가 그중 하나를 품고 있으면 제목 요소 자체가 항목 컨테이너다. 세 번째부터는 해소 못 하면 그 자리만 null로 두어
// 항목 하나의 오보가 전체 합성을 막지 않게 한다. 첫 두 제목이나 세 번째 제목과의
// 교차 검증이 실패하면 구조를 신뢰할 수 없어 배열 전체를 null로 돌려준다.
export function resolveItemRoots(titleEls: Element[], contents: Element[][] = []): (Element | null)[] | null {
  if (titleEls.length < MIN_RESOLVED_ITEMS) return null;
  const isContainer = (i: number): boolean => (contents[i] ?? []).some((el) => el !== titleEls[i] && titleEls[i].contains(el));
  const pair = splitAtCommonAncestor(titleEls[0], titleEls[1], isContainer(0), isContainer(1));
  if (!pair) return null;

  const roots: (Element | null)[] = [pair.first, pair.second];
  const seen = new Set<Element>(roots as Element[]);
  for (let i = CROSS_CHECK_INDEX; i < titleEls.length; i++) {
    const root = rootBeyondPair(pair, titleEls[0], titleEls[i], isContainer(i));
    if (root && seen.has(root)) {
      // 세 번째 제목이 앞선 항목과 같은 루트면 두 제목이 한 항목에 있다는 뜻이라 첫 쌍의 해석이 틀렸을 수 있다.
      if (i === CROSS_CHECK_INDEX) return null;
      roots.push(null);
      continue;
    }
    if (root) seen.add(root);
    roots.push(root);
  }
  return roots;
}

// ── 3단계 보강: itemSelector를 모든 루트의 공통 조상으로 좁힌다 ──

function matchesCovering(document: Document, selector: string, roots: Element[]): Element[] | null {
  try {
    const matched = [...document.querySelectorAll(selector)];
    return roots.every((r) => matched.includes(r)) ? matched : null;
  } catch {
    return null;
  }
}

function lowestCommonAncestor(roots: Element[]): Element | null {
  return ancestorChain(roots[0]).slice(1).find((a) => roots.every((r) => a.contains(r))) ?? null;
}

// 공통 조상을 식별하는 접두 후보. 접두 뒤에는 원래 셀렉터를 그대로 이을 수도 있고,
// 루트가 모두 같은 태그의 직계 자식이면 `> tag`로 이을 수도 있다(원래 셀렉터가 `ul > li`처럼
// 부모를 이미 품은 형태일 때는 뒤쪽만 유효하다).
function narrowingCandidates(document: Document, roots: Element[], ancestor: Element, selector: string): string[] {
  const tags = new Set(roots.map((r) => r.tagName.toLowerCase()));
  const directChildren = tags.size === 1 && roots.every((r) => r.parentElement === ancestor);
  const prefixes = [parentSelector(ancestor)];
  const absolute = relativeSelector(document.documentElement, ancestor);
  if (absolute) prefixes.push(absolute);
  return prefixes.flatMap((prefix) => [
    `${prefix} ${selector}`,
    ...(directChildren ? [`${prefix} > ${[...tags][0]}`] : []),
  ]);
}

// commonSelector는 "대상을 모두 포함함"만 보증해서 목록 밖의 같은 클래스·같은 태그 요소까지 잡는다
// (사이드바의 `li.it`). 우리는 공통 조상을 알고 있으니, 초과분이 그 밖에 있으면 조상을 접두로 붙인
// 후보 중 여전히 모든 루트를 포함하면서 더 적게 잡는 것을 채택한다 — 거짓 음성이 생기지 않는다.
// 조상 안쪽의 초과분(같은 컨테이너의 페이저 li 등)은 구분할 근거가 없으므로 검증 단계의 몫으로 남긴다.
function narrowItemSelector(document: Document, roots: Element[], selector: string): string {
  const matched = matchesCovering(document, selector, roots);
  const ancestor = lowestCommonAncestor(roots);
  if (!matched || !ancestor) return selector;
  const rootSet = new Set(roots);
  if (!matched.some((el) => !rootSet.has(el) && !ancestor.contains(el))) return selector;

  let best = { selector, count: matched.length };
  for (const candidate of narrowingCandidates(document, roots, ancestor, selector)) {
    const covered = matchesCovering(document, candidate, roots);
    if (covered && covered.length < best.count) best = { selector: candidate, count: covered.length };
  }
  return best.selector;
}

// ── 4단계: 상대 셀렉터의 일반화 ──

function reaches({ root, el }: Sample, selector: string): boolean {
  try {
    return root.querySelector(selector) === el;
  } catch {
    return false;
  }
}

function commonSuffixLength(paths: string[][]): number {
  const shortest = Math.min(...paths.map((p) => p.length));
  let n = 0;
  while (n < shortest && paths.every((p) => p[p.length - 1 - n] === paths[0][paths[0].length - 1 - n])) n++;
  return n;
}

// 항목마다 구한 상대 셀렉터가 전부 같으면 그대로, 다르면 공통 접미로 줄인다.
// 어느 쪽이든 각 항목의 루트에서 실제로 실행해 대상 요소에 닿는 것만 채택한다.
// (relativeSelector가 항목별로 이미 검증하지만, 접미로 줄이면 다시 보증해야 한다.)
function generalizeSelector(samples: Sample[]): string | null {
  const paths = samples.flatMap((s) => {
    const rel = relativeSelector(s.root, s.el);
    return rel === null ? [] : [{ sample: s, pieces: rel.split(" > ") }];
  });
  if (paths.length === 0) return null;

  const full = paths[0].pieces.join(" > ");
  if (paths.every((p) => p.pieces.join(" > ") === full)) return full;

  const pieceLists = paths.map((p) => p.pieces);
  for (let n = commonSuffixLength(pieceLists); n >= 1; n--) {
    const selector = paths[0].pieces.slice(-n).join(" > ");
    if (paths.every((p) => reaches(p.sample, selector))) return selector;
  }
  return null;
}

// ── 5단계: 값 추출 방식 ──

function imageAttr(img: Element): string {
  // 지연 로딩 사이트는 src에 자리표시 이미지를 둔다. 개요도 data-* 를 우선해 보여 준다.
  if (img.hasAttribute("data-src")) return "data-src";
  if (img.hasAttribute("data-original")) return "data-original";
  return "src";
}

function valueAttr(el: Element, type: FieldType): string | undefined {
  const tag = el.tagName.toLowerCase();
  if (tag === "img") return imageAttr(el);
  if (tag === "a" && type === "url") return "href";
  if (tag === "time" && el.hasAttribute("datetime")) return "datetime";
  return undefined;
}

// ── 앵커 ──

function isLinkAnchor(el: Element): boolean {
  return el.tagName.toLowerCase() === "a" && el.hasAttribute("href");
}

// el 자신 또는 가장 가까운 조상 중 a[href], 없으면 el 안의 첫 a[href].
// 제목이 앵커 안쪽 span이면 링크는 그 span의 조상 앵커다. 항목 루트는 상대 셀렉터로 지정할 수 없어 제외한다.
function anchorNear(root: Element, el: Element): Element | null {
  for (let cur: Element | null = el; cur && cur !== root; cur = cur.parentElement) {
    if (isLinkAnchor(cur)) return cur;
  }
  return el.querySelector("a[href]");
}

// ── 3·4·6단계 조립 ──

function toSamples(located: LocatedItem[], pick: (l: LocatedItem) => Element | null): Sample[] {
  return located.flatMap((l) => {
    const el = pick(l);
    return el ? [{ root: l.root, el }] : [];
  });
}

// 제목 셀렉터 하나를 못 만든 것이 목록을 못 찾은 것은 아니므로 null 대신 생략한다.
// 생략하면 applyDomSpec이 기존 추측으로 제목을 뽑는다.
function synthesizeTitleSelector(ctx: Context, located: LocatedItem[]): string | null {
  const selfCount = located.filter((l) => l.item.title === l.root).length;
  // 상대 셀렉터는 후손만 가리키므로 제목이 항목 자신이면 센티넬로 표현한다.
  if (selfCount === located.length) return SELF_TITLE_SELECTOR;
  // 섞인 구조에 센티넬을 쓰면 앵커가 있는 항목의 제목을 직계 텍스트로 덮어 망친다.
  if (selfCount > 0) {
    drop(ctx, "title", "일부 항목만 제목이 항목 루트 자신이라 titleSelector를 생략했다");
    return null;
  }
  const selector = generalizeSelector(toSamples(located, (l) => l.item.title));
  if (!selector) drop(ctx, "title", "항목 사이에 공통 제목 셀렉터를 만들 수 없어 titleSelector를 생략했다");
  return selector;
}

// 제목과 링크를 항상 함께 지정한다. linkSelector가 없으면 applyDomSpec이 항목에서 가장 긴 앵커를
// 링크로 추측하므로, 긴 요약 앵커가 있는 항목에서 제목과 다른 페이지로 이동하게 된다.
function synthesizeLinkSelector(ctx: Context, located: LocatedItem[], pageUrl: string): string | null {
  const usable = (a: Element): boolean => absolutize(a.getAttribute("href") ?? "", pageUrl) !== null;
  const samples = toSamples(located, ({ root, item }) => {
    const anchor =
      (item.linkEl ? anchorNear(root, item.linkEl) : null) ?? anchorNear(root, item.title);
    return anchor && usable(anchor) ? anchor : null;
  });
  if (samples.length === 0) {
    drop(ctx, "link", "제목 주변에 사용할 수 있는 a[href]가 없어 linkSelector를 만들지 못했다");
    return null;
  }
  const selector = generalizeSelector(samples);
  if (!selector) drop(ctx, "link", "항목 사이에 공통 링크 셀렉터를 만들 수 없다");
  return selector;
}

interface FieldGroup {
  meta: ResolvedField;
  members: Sample[];
}

// 같은 key의 필드를 항목들에 걸쳐 모은다. label/type/role은 처음 보고된 것을 쓴다.
function groupByKey(located: LocatedItem[]): Map<string, FieldGroup> {
  const groups = new Map<string, FieldGroup>();
  for (const { root, item } of located) {
    for (const field of item.fields) {
      const group = groups.get(field.key) ?? { meta: field, members: [] };
      group.members.push({ root, el: field.el });
      groups.set(field.key, group);
    }
  }
  return groups;
}

function groupSamples(group: FieldGroup): Sample[] {
  return group.members.flatMap(({ root, el }) => {
    // url 필드는 값이 href이므로 보고된 요소가 앵커 안쪽 텍스트여도 앵커로 옮긴다.
    const target = group.meta.type === "url" ? anchorNear(root, el) : el;
    return target ? [{ root, el: target }] : [];
  });
}

function synthesizeFieldSelector(ctx: Context, key: string, group: FieldGroup): FieldSelector | null {
  const samples = groupSamples(group);
  if (samples.length === 0) {
    drop(ctx, key, "url 필드인데 항목 안에 a[href]가 없다");
    return null;
  }
  const selector = generalizeSelector(samples);
  if (!selector) {
    drop(ctx, key, "항목 사이에 공통 상대 셀렉터를 만들 수 없다");
    return null;
  }
  const { label, type, role } = group.meta;
  const attr = valueAttr(samples[0].el, type);
  return { selector, ...(attr ? { attr } : {}), label, type, role };
}

function synthesizePublishedSelector(ctx: Context, groups: [string, FieldGroup][]): string | null {
  const [first, ...rest] = groups;
  for (const [key] of rest) drop(ctx, key, "게시일 필드는 하나만 쓴다. 먼저 보고된 것을 채택했다");
  if (!first) return null;

  const [key, group] = first;
  const selector = generalizeSelector(groupSamples(group));
  if (!selector) drop(ctx, key, "항목 사이에 공통 게시일 셀렉터를 만들 수 없다");
  return selector;
}

function locateItems(ctx: Context, items: ResolvedItem[], roots: (Element | null)[]): LocatedItem[] {
  return items.flatMap((item, i) => {
    const root = roots[i];
    if (root) return [{ root, item }];
    drop(ctx, `items[${item.index}]`, "항목 루트를 정할 수 없어 제외했다");
    return [];
  });
}

export function synthesizeSpec(
  outline: PageOutline,
  read: PageReadResult,
  pageUrl: string,
): SynthesisResult | null {
  const ctx: Context = { outline, dropped: [], remapped: 0 };

  const items = read.items.flatMap((it, i) => {
    const resolved = resolveItem(ctx, it, i);
    return resolved ? [resolved] : [];
  });
  if (items.length < MIN_RESOLVED_ITEMS) return null;

  const roots = resolveItemRoots(
    items.map((i) => i.title),
    items.map((i) => [...i.fields.map((f) => f.el), ...(i.linkEl ? [i.linkEl] : [])]),
  );
  if (!roots) return null;
  const located = locateItems(ctx, items, roots);

  const itemRoots = located.map((l) => l.root);
  const commonItemSelector = commonSelector(itemRoots);
  if (!commonItemSelector) return null;
  const itemSelector = narrowItemSelector(outline.document, itemRoots, commonItemSelector);

  const titleSelector = synthesizeTitleSelector(ctx, located);
  const linkSelector = synthesizeLinkSelector(ctx, located, pageUrl);

  const groups = [...groupByKey(located)];
  const published = groups.filter(([, g]) => g.meta.role === "published");
  const publishedSelector = synthesizePublishedSelector(ctx, published);

  const fields: Record<string, FieldSelector> = {};
  for (const [key, group] of groups) {
    if (group.meta.role === "published") continue;
    const field = synthesizeFieldSelector(ctx, key, group);
    if (field) fields[key] = field;
  }

  const spec: CrawlSpec = {
    strategy: "html",
    itemSelector,
    fields,
    ...(titleSelector ? { titleSelector } : {}),
    ...(linkSelector ? { linkSelector } : {}),
    ...(publishedSelector ? { publishedSelector } : {}),
    fieldSource: "llm",
  };
  return { spec, dropped: ctx.dropped, remapped: ctx.remapped };
}
