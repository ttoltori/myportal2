import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { commonSelector, relativeSelector } from "./dom-selector";

function doc(html: string) {
  return parseHTML(`<html><body>${html}</body></html>`).document;
}

function must<T>(v: T | null | undefined): T {
  if (v == null) throw new Error("요소를 찾지 못했다");
  return v;
}

describe("relativeSelector", () => {
  it("클래스가 있으면 클래스로 상대 셀렉터를 만든다", () => {
    const d = doc(`<li class="item"><span class="date">2026-01-05</span></li>`);
    const root = must(d.querySelector("li"));
    const span = must(d.querySelector("span"));
    const sel = relativeSelector(root, span);
    expect(sel).toBe("span.date");
    expect(root.querySelector(must(sel))).toBe(span);
  });

  it("클래스가 없으면 nth-child로 경로를 만든다", () => {
    const d = doc(`<li><div><span>값</span></div></li>`);
    const root = must(d.querySelector("li"));
    const span = must(d.querySelector("span"));
    const sel = relativeSelector(root, span);
    expect(sel).toBe("div:nth-child(1) > span:nth-child(1)");
    expect(root.querySelector(must(sel))).toBe(span);
  });

  it("같은 클래스의 형제 중 두 번째 요소는 첫 번째로 잘못 닿지 않는다", () => {
    const d = doc(`<li><b class="v">A</b><b class="v">B</b></li>`);
    const root = must(d.querySelector("li"));
    const second = must(d.querySelectorAll("b")[1]);
    const sel = must(relativeSelector(root, second));
    expect(root.querySelector(sel)).toBe(second);
  });

  it("root 자신을 가리키면 null을 반환한다", () => {
    const d = doc(`<li><span>x</span></li>`);
    const root = must(d.querySelector("li"));
    expect(relativeSelector(root, root)).toBeNull();
  });

  it("root의 후손이 아니면 null을 반환한다", () => {
    const d = doc(`<li id="a"><span>x</span></li><p><i>y</i></p>`);
    const root = must(d.querySelector("#a"));
    expect(relativeSelector(root, must(d.querySelector("i")))).toBeNull();
  });

  it("클래스에 CSS 특수문자가 있으면 이스케이프한다", () => {
    const d = doc(`<li><div class="w-1/2">x</div></li>`);
    const root = must(d.querySelector("li"));
    const div = must(d.querySelector("div"));
    const sel = must(relativeSelector(root, div));
    expect(sel).toBe("div.w-1\\/2");
    expect(root.querySelector(sel)).toBe(div);
  });
});

describe("commonSelector", () => {
  it("공통 클래스가 있으면 모든 요소를 포함하는 셀렉터를 만든다", () => {
    const d = doc(`<ul><li class="row a">1</li><li class="row b">2</li><li class="row">3</li></ul><li class="other">x</li>`);
    const els = Array.from(d.querySelectorAll("ul > li"));
    const sel = must(commonSelector(els));
    expect(sel).toBe("li.row");
    const hit = Array.from(d.querySelectorAll(sel));
    expect(hit).toEqual(els);
  });

  it("공통 클래스가 없으면 부모 기준 자식 셀렉터를 만든다", () => {
    const d = doc(`<div class="list"><ul><li>1</li><li>2</li></ul></div><ul><li>밖</li></ul>`);
    const els = Array.from(must(d.querySelector(".list ul")).children);
    const sel = must(commonSelector(els));
    expect(Array.from(d.querySelectorAll(sel))).toEqual(els);
  });

  it("공통 클래스가 여럿이면 대상 밖 요소에 덜 붙은 가장 좁은 클래스를 고른다", () => {
    // item은 메뉴에도 붙어 있어 li.item은 과포함이다. x는 대상에만 있다.
    const d = doc(`<nav><li class="item">메뉴</li><li class="item">메뉴2</li></nav><ul><li class="item x">1</li><li class="item x">2</li></ul>`);
    const els = Array.from(must(d.querySelector("ul")).children);
    const sel = must(commonSelector(els));
    expect(sel).toBe("li.x");
    expect(Array.from(d.querySelectorAll(sel))).toEqual(els);
  });

  it("태그가 서로 달라도 공통 클래스만으로 모든 요소를 포함하고 가장 좁은 클래스를 고른다", () => {
    // 태그가 섞여 있으면 tag 없이 .클래스만 쓴다. box는 대상 밖 div에도 붙어 있다.
    const d = doc(`<div class="box">밖</div><section><p class="box mine">1</p><div class="box mine">2</div></section>`);
    const els = Array.from(must(d.querySelector("section")).children);
    const sel = must(commonSelector(els));
    expect(sel).toBe(".mine");
    expect(Array.from(d.querySelectorAll(sel))).toEqual(els);
  });

  it("공통 클래스가 대상 밖 요소에도 붙어 있으면 과포함이어도 모든 대상은 포함한다", () => {
    const d = doc(`<div class="box">밖</div><section><p class="box">1</p><div class="box">2</div></section>`);
    const els = Array.from(must(d.querySelector("section")).children);
    const sel = must(commonSelector(els));
    expect(sel).toBe(".box");
    const hit = new Set(Array.from(d.querySelectorAll(sel)));
    expect(els.every((e) => hit.has(e))).toBe(true);
    expect(hit.size).toBeGreaterThan(els.length);
  });

  it("빈 배열이면 null을 반환한다", () => {
    expect(commonSelector([])).toBeNull();
  });

  it("모든 요소를 포함하는 셀렉터를 만들 수 없으면 null을 반환한다", () => {
    const d = doc(`<ul><li>1</li></ul><ol><p>2</p></ol>`);
    const els = [must(d.querySelector("li")), must(d.querySelector("p"))];
    expect(commonSelector(els)).toBeNull();
  });
});
