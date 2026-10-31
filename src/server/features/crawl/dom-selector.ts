// CSS 셀렉터 생성 유틸. 스펙 생성(extract)과 LLM 응답의 ref → 셀렉터 합성(analyze)이
// 같은 규칙으로 셀렉터를 만들어야 저장된 스펙이 일관되므로 한곳에 둔다.

export function cssEscape(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function firstClass(el: Element): string {
  return (el.getAttribute("class") ?? "").trim().split(/\s+/)[0] ?? "";
}

export function selectorFor(el: Element): string {
  const cls = firstClass(el);
  return cls ? `${el.tagName.toLowerCase()}.${cssEscape(cls)}` : el.tagName.toLowerCase();
}

// 클래스/id가 없는 범용 태그(예: 그냥 ul)는 셀렉터가 너무 넓어지므로
// 가장 가까운 식별 가능한 조상으로 한정한다.
export function parentSelector(el: Element): string {
  const id = el.getAttribute("id");
  if (id) return `#${cssEscape(id)}`;
  const sel = selectorFor(el);
  if (sel.includes(".")) return sel;
  let anc = el.parentElement;
  while (anc) {
    const aid = anc.getAttribute("id");
    if (aid) return `#${cssEscape(aid)} ${sel}`;
    const c = firstClass(anc);
    if (c) return `${anc.tagName.toLowerCase()}.${cssEscape(c)} ${sel}`;
    anc = anc.parentElement;
  }
  return sel;
}

function nthChildPiece(el: Element): string {
  const parent = el.parentElement;
  const index = parent ? Array.from(parent.children).indexOf(el) + 1 : 1;
  return `${el.tagName.toLowerCase()}:nth-child(${index})`;
}

function isDescendant(root: Element, el: Element): boolean {
  for (let cur = el.parentElement; cur; cur = cur.parentElement) {
    if (cur === root) return true;
  }
  return false;
}

// el에서 root 직전까지 올라가며 단계별 조각을 모아 ">"로 잇는다.
function buildPath(root: Element, el: Element, piece: (e: Element) => string): string {
  const pieces: string[] = [];
  for (let cur: Element | null = el; cur && cur !== root; cur = cur.parentElement) {
    pieces.unshift(piece(cur));
  }
  return pieces.join(" > ");
}

// root.querySelector(결과)로 el에 도달하는 상대 셀렉터.
// 클래스 기반 조각은 형제에 같은 클래스가 있으면 el이 아닌 요소에 먼저 닿을 수 있어,
// 실제로 실행해 검증하고 어긋나면 위치 기반 경로로 되돌린다.
export function relativeSelector(root: Element, el: Element): string | null {
  if (el === root || !isDescendant(root, el)) return null;

  const classBased = buildPath(root, el, (e) => {
    const cls = firstClass(e);
    return cls ? `${e.tagName.toLowerCase()}.${cssEscape(cls)}` : nthChildPiece(e);
  });
  if (root.querySelector(classBased) === el) return classBased;

  const positional = buildPath(root, el, nthChildPiece);
  return root.querySelector(positional) === el ? positional : null;
}

function matchesAll(els: Element[], selector: string): boolean {
  const matched = els[0].ownerDocument.querySelectorAll(selector);
  const set = new Set<Element>(Array.from(matched));
  return els.every((e) => set.has(e));
}

// 여러 요소(예: 목록 항목들)를 모두 포함하는 공통 셀렉터.
// 공통 클래스가 있으면 그것을, 없으면 같은 부모의 같은 태그 자식이라는 관계를 쓴다.
// 후보마다 문서에서 실제로 실행해 모든 요소를 포함하는지 확인한다.
export function commonSelector(els: Element[]): string | null {
  if (els.length === 0) return null;

  const classLists = els.map((e) =>
    (e.getAttribute("class") ?? "").trim().split(/\s+/).filter(Boolean),
  );
  const commonClasses = classLists[0].filter((c) => classLists.every((l) => l.includes(c)));
  const tags = new Set(els.map((e) => e.tagName.toLowerCase()));
  const tag = tags.size === 1 ? [...tags][0] : "";

  for (const cls of commonClasses) {
    const candidate = `${tag}.${cssEscape(cls)}`;
    if (matchesAll(els, candidate)) return candidate;
  }

  const parent = els[0].parentElement;
  if (parent && tag && els.every((e) => e.parentElement === parent)) {
    const candidate = `${parentSelector(parent)} > ${tag}`;
    if (matchesAll(els, candidate)) return candidate;
  }
  return null;
}
