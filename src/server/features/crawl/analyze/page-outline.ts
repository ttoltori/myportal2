import { parseHTML } from "linkedom";
import { stripNoise } from "../extract";

// LLM에게 DOM 대신 줄 앞에 [n] 번호가 붙은 텍스트 개요를 준다. 난독화된 클래스와 깊은
// 중첩 속에서 셀렉터를 직접 쓰게 하면 틀리지만, 번호를 가리키게 하면 틀릴 일이 없다.
// 셀렉터는 다른 모듈이 refs[n]의 조상 체인에서 역산한다.
//
// 이 파일의 출력 형식은 llm-read.ts의 NUMBERED_LINE / VISIBLE_TEXT 정규식과 시스템
// 프롬프트에 결합되어 있다. 줄 형식이나 링크 구역 헤더를 바꾸면 예외 없이 힌트 매칭이
// 항상 false가 되므로 반드시 함께 고친다.

export const OUTLINE_MAX_BYTES = 48 * 1024;
export const TEXT_NODE_LIMIT = 120;
export const LINK_SECTION_LIMIT = 40;

const HREF_LIMIT = 120;
const INDENT_MAX_DEPTH = 16;
const INDENT_UNIT = "  ";
export const LINK_SECTION_HEADER = "── 페이지 내 링크 (목록 후보 판단용) ──";
const EMPTY_LINK_SECTION_LINE = "(없음)";

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

// 본문이 아닌 요소. head는 body가 비어 documentElement로 폴백할 때만 섞여 들어온다.
const SKIPPED_TAGS = new Set(["head", "title", "meta", "link", "base", "br", "wbr"]);

// 이 요소들만 들어 있는 앵커는 "텍스트 한 줄짜리 링크"로 본다. 그 밖의 블록 요소를
// 품은 앵커(카드 전체를 <a>로 감싼 경우)는 안쪽 텍스트를 각각 번호로 보여야 제목과
// 요약을 구분해서 가리킬 수 있다.
const INLINE_TAGS = new Set([
  "span", "b", "strong", "em", "i", "u", "s", "small", "sub", "sup", "mark",
  "abbr", "time", "font", "del", "ins", "code", "img",
]);

const NON_NAVIGATION_HREF = /^(?:#|javascript:|mailto:|tel:)/i;

export interface PageOutline {
  text: string;
  // 인덱스 → 요소. 0번은 쓰지 않는다. 텍스트 노드의 ref는 그 부모 요소다.
  refs: (Element | null)[];
  truncated: boolean;
  // refs의 요소가 속한 문서. 셀렉터 합성이 같은 인스턴스에서 조상 체인을 타야 하므로
  // 호출자가 html을 다시 파싱하면 안 된다.
  document: Document;
}

function foldText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

// 문장 경계를 맞출 필요가 없고, 줄임표를 붙이면 모델이 text에 그대로 옮겨 적는다.
function clip(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) : text;
}

// llm-read.ts의 VISIBLE_TEXT가 `a→\S*`로 주소를 떼므로 주소 안에 공백이 없어야 한다.
function compactHref(href: string): string {
  return clip(href.trim().replace(/\s+/g, "%20"), HREF_LIMIT);
}

function indent(depth: number): string {
  return INDENT_UNIT.repeat(Math.min(depth, INDENT_MAX_DEPTH));
}

function isSimpleAnchor(a: Element): boolean {
  return [...a.querySelectorAll("*")].every((el) =>
    INLINE_TAGS.has(el.tagName.toLowerCase()),
  );
}

function imageSource(img: Element): string {
  // 지연 로딩 사이트는 src에 자리표시 이미지를 두고 실제 주소를 data-* 에 둔다.
  const real = img.getAttribute("data-src") ?? img.getAttribute("data-original");
  return real?.trim() || img.getAttribute("src")?.trim() || "";
}

class OutlineBuilder {
  readonly lines: string[] = [];
  readonly refs: (Element | null)[] = [null];
  truncated = false;
  private bytes = 0;

  constructor(private readonly budget: number) {}

  // 예산을 넘으면 번호를 받지 못하고 순회가 멈춘다. 번호와 줄이 항상 1:1이어야 하므로
  // 줄을 만들 수 있는지 먼저 확인한 뒤에만 번호를 부여한다.
  emit(depth: number, el: Element, body: string): void {
    if (this.truncated) return;
    const line = `${indent(depth)}[${this.refs.length}] ${body}`;
    const cost = Buffer.byteLength(line, "utf8") + 1;
    if (this.bytes + cost > this.budget) {
      this.truncated = true;
      return;
    }
    this.bytes += cost;
    this.lines.push(line);
    this.refs.push(el);
  }
}

function walkChildren(parent: Element, depth: number, out: OutlineBuilder): void {
  for (const child of [...parent.childNodes]) {
    if (out.truncated) return;
    if (child.nodeType === TEXT_NODE) {
      const text = clip(foldText(child.textContent ?? ""), TEXT_NODE_LIMIT);
      if (text) out.emit(depth, parent, `"${text}"`);
    } else if (child.nodeType === ELEMENT_NODE) {
      walkElement(child as Element, depth + 1, out);
    }
  }
}

function emitImage(img: Element, depth: number, out: OutlineBuilder): void {
  const src = imageSource(img);
  if (!src) return;
  const alt = clip(foldText(img.getAttribute("alt") ?? ""), TEXT_NODE_LIMIT);
  out.emit(depth, img, `img→${compactHref(src)} "${alt}"`);
}

// 텍스트 한 줄짜리 앵커 안에서는 텍스트를 다시 번호 매기지 않고 이미지만 남긴다.
function walkImagesOnly(parent: Element, depth: number, out: OutlineBuilder): void {
  for (const child of [...parent.children]) {
    if (out.truncated) return;
    if (child.tagName.toLowerCase() === "img") emitImage(child, depth, out);
    else walkImagesOnly(child, depth, out);
  }
}

function walkAnchor(a: Element, href: string, depth: number, out: OutlineBuilder): void {
  const target = compactHref(href);
  if (!isSimpleAnchor(a)) {
    // 카드 전체를 감싼 링크: 링크 자체는 ref로 남기고 안쪽 내용은 각자 번호를 받는다.
    out.emit(depth, a, `a→${target} ""`);
    walkChildren(a, depth, out);
    return;
  }
  const label = clip(foldText(a.textContent ?? ""), TEXT_NODE_LIMIT);
  const hasImage = a.querySelector("img") !== null;
  if (!label && !hasImage) return;
  out.emit(depth, a, `a→${target} "${label}"`);
  walkImagesOnly(a, depth + 1, out);
}

function walkElement(el: Element, depth: number, out: OutlineBuilder): void {
  const tag = el.tagName.toLowerCase();
  if (SKIPPED_TAGS.has(tag)) return;
  if (tag === "img") {
    emitImage(el, depth, out);
    return;
  }
  const href = tag === "a" ? el.getAttribute("href") : null;
  if (href !== null && href.trim() !== "") {
    walkAnchor(el, href, depth, out);
    return;
  }
  walkChildren(el, depth, out);
}

function pickRoot(document: Document): Element | null {
  // <html> 없는 조각을 파싱하면 linkedom이 빈 body를 만들고 내용은 documentElement에
  // 남는다. body가 비어 있으면 documentElement를 쓴다.
  // 빈 문자열은 documentElement 자체가 없고, 그때 body 접근자는 예외를 던진다.
  if (!document.documentElement) return null;
  const body = document.body;
  if (body && body.childNodes.length > 0) return body;
  return document.documentElement ?? null;
}

// textContent는 블록 사이 공백이 없어 "제목요약"처럼 붙으므로 텍스트 노드를 공백으로 잇는다.
function joinedText(el: Element): string {
  const parts: string[] = [];
  const collect = (node: Node): void => {
    if (node.nodeType === TEXT_NODE) parts.push(node.textContent ?? "");
    else for (const child of node.childNodes) collect(child);
  };
  collect(el);
  return foldText(parts.join(" "));
}

function linkLabel(a: Element): string {
  const text = joinedText(a);
  if (text) return text;
  return foldText(
    a.getAttribute("title") ??
      a.getAttribute("aria-label") ??
      a.querySelector("img")?.getAttribute("alt") ??
      "",
  );
}

// stripNoise 전의 원본 문서에서 모은다: 상세 페이지에서 목록으로 가는 링크는 보통
// nav에 있고, nav는 번호 매기는 문서에서 이미 지워졌다. 번호는 붙이지 않는다 —
// 셀렉터 합성에 쓰이지 않고 목록 후보 URL을 고르는 데만 쓰이기 때문이다.
function buildLinkSection(originalDocument: Document): { text: string; count: number } {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const a of originalDocument.querySelectorAll("a[href]")) {
    if (lines.length >= LINK_SECTION_LIMIT) break;
    const href = (a.getAttribute("href") ?? "").trim();
    if (!href || NON_NAVIGATION_HREF.test(href) || seen.has(href)) continue;
    const label = clip(linkLabel(a), TEXT_NODE_LIMIT);
    if (!label) continue;
    seen.add(href);
    lines.push(`${label} → ${compactHref(href)}`);
  }
  const body = lines.length > 0 ? lines : [EMPTY_LINK_SECTION_LINE];
  return { text: [LINK_SECTION_HEADER, ...body].join("\n"), count: lines.length };
}

// 개요의 번호는 stripNoise를 적용한 문서의 요소를 가리킨다. applySpec이 추출 전에
// 같은 stripNoise를 호출하므로, 원본 DOM에서 번호를 붙이면 LLM이 가리킨 노드가 추출
// 시점에는 없어 합성한 셀렉터가 0건을 뽑는다. ref 공간과 applySpec의 DOM이 같아야 한다.
export function buildPageOutline(html: string): PageOutline {
  const { document } = parseHTML(html);
  const { document: original } = parseHTML(html);

  const links = buildLinkSection(original);
  const root = pickRoot(document);

  stripNoise(document);
  // stripNoise는 svg를 지우지 않는다. 아이콘 path 따위는 텍스트가 없어 번호는 받지
  // 않지만 title 같은 자식 텍스트가 섞이므로 걷어낸다.
  for (const svg of [...document.querySelectorAll("svg")]) svg.remove();

  const empty: PageOutline = { text: "", refs: [null], truncated: false, document };
  if (!root) return empty;

  // 링크 구역은 절단 후에도 반드시 붙는다(시스템 프롬프트가 전제). 그래서 본문 예산에서
  // 미리 빼 둔다 — 본문을 뒤에서 자르면 푸터가 먼저 사라진다.
  const bodyBudget = OUTLINE_MAX_BYTES - Buffer.byteLength(links.text, "utf8") - 2;
  const out = new OutlineBuilder(bodyBudget);
  walkChildren(root, 0, out);

  if (out.lines.length === 0 && links.count === 0) return empty;

  return {
    text: out.lines.length > 0 ? `${out.lines.join("\n")}\n\n${links.text}` : links.text,
    refs: out.refs,
    truncated: out.truncated,
    document,
  };
}
