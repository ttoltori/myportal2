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

  it("빈 배열이면 null을 반환한다", () => {
    expect(commonSelector([])).toBeNull();
  });

  it("모든 요소를 포함하는 셀렉터를 만들 수 없으면 null을 반환한다", () => {
    const d = doc(`<ul><li>1</li></ul><ol><p>2</p></ol>`);
    const els = [must(d.querySelector("li")), must(d.querySelector("p"))];
    expect(commonSelector(els)).toBeNull();
  });
});
