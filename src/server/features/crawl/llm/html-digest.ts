import { parseHTML } from "linkedom";

// LLM 입력용 DOM 축약. 셀렉터 생성에 필요한 구조(class/id/data-*)는 남기고
// 토큰만 먹는 요소·속성·긴 텍스트를 덜어낸다. extract.ts의 stripNoise와 같은 기조.

export const ITEM_DIGEST_COUNT = 3;
export const ITEM_DIGEST_BYTES = 2_048;
export const ITEMS_DIGEST_BYTES = 6_144;
export const PAGE_DIGEST_BYTES = 20_480;
export const TEXT_NODE_LIMIT = 80;

const REMOVED_ELEMENTS = "script, style, svg, noscript, iframe";
const PAGE_CHROME_ELEMENTS = "header, nav, footer, aside";
const KEPT_ATTRIBUTES = new Set(["class", "id", "href", "src", "datetime", "title"]);
const DATA_ATTRIBUTE_PREFIX = "data-";
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const COMMENT_NODE = 8;

function isKeptAttribute(name: string): boolean {
  return KEPT_ATTRIBUTES.has(name) || name.startsWith(DATA_ATTRIBUTE_PREFIX);
}

function foldText(raw: string): string {
  const folded = raw.replace(/\s+/g, " ").trim();
  // 문자 단위 절단: LLM은 패턴만 보므로 문장 경계를 맞출 필요가 없다.
  return folded.length > TEXT_NODE_LIMIT
    ? `${folded.slice(0, TEXT_NODE_LIMIT)}…`
    : folded;
}

function cleanChildren(el: Element): void {
  for (const child of [...el.childNodes]) {
    if (child.nodeType === COMMENT_NODE) {
      child.remove();
    } else if (child.nodeType === TEXT_NODE) {
      const text = foldText(child.textContent ?? "");
      if (text) child.textContent = text;
      else child.remove();
    } else if (child.nodeType === ELEMENT_NODE) {
      cleanElement(child as Element);
    }
  }
}

function cleanElement(el: Element): void {
  for (const name of el.getAttributeNames()) {
    if (!isKeptAttribute(name)) el.removeAttribute(name);
  }
  cleanChildren(el);
}

function removeAll(root: Element, selector: string): void {
  for (const el of [...root.querySelectorAll(selector)]) el.remove();
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) : value;
}

// 루트 하위의 불필요 요소·주석·속성·긴 텍스트를 제자리에서 정리한다.
function digest(root: Element): string {
  removeAll(root, REMOVED_ELEMENTS);
  cleanElement(root);
  return root.outerHTML;
}

export function digestItems(html: string, itemSelector: string): string {
  const { document } = parseHTML(html);
  let items: Element[];
  try {
    items = [...document.querySelectorAll(itemSelector)];
  } catch {
    // LLM이나 휴리스틱이 만든 셀렉터는 문법이 깨져 있을 수 있다.
    return "";
  }
  const digests = items
    .slice(0, ITEM_DIGEST_COUNT)
    .map((el) => truncate(digest(el), ITEM_DIGEST_BYTES));
  return truncate(digests.join("\n"), ITEMS_DIGEST_BYTES);
}

export function digestPage(html: string): string {
  const { document } = parseHTML(html);
  // <html> 없는 조각을 파싱하면 linkedom이 빈 body를 만들고 내용은 documentElement에
  // 남긴다 — body가 비어 있으면 documentElement를 쓴다.
  const body = document.body;
  const root =
    body && body.childNodes.length > 0 ? body : document.documentElement;
  if (!root) return "";
  removeAll(root, `${PAGE_CHROME_ELEMENTS}, head`);
  return truncate(digest(root), PAGE_DIGEST_BYTES);
}
