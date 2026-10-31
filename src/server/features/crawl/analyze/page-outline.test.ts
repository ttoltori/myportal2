import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { stripNoise } from "../extract";
import { hintMatchesOutline } from "./llm-read";
import {
  buildPageOutline,
  LINK_SECTION_HEADER,
  LINK_SECTION_LIMIT,
  OUTLINE_MAX_BYTES,
  TEXT_NODE_LIMIT,
} from "./page-outline";

const page = (body: string): string => `<html><body>${body}</body></html>`;

const NOTICE_TABLE = page(`
  <nav><a href="/notice/list.it">사업공고</a><a href="/board/index.it">알림마당</a></nav>
  <table><tbody>
    <tr><th>번호</th><th>제목</th><th>접수기간</th></tr>
    <tr>
      <td><a href="/notice/1234">2026년 AI 바우처 지원사업 공고</a></td>
      <td>정보통신산업진흥원</td>
      <td>접수기간: <span>2026-01-05</span></td>
    </tr>
  </tbody></table>
  <footer>저작권 안내</footer>
`);

const numberedLines = (text: string): string[] =>
  text.split("\n").filter((line) => /^\s*\[\d+\]/.test(line));

describe("buildPageOutline", () => {
  it("텍스트 노드와 링크에 1부터 번호를 붙인다", () => {
    const { text, refs } = buildPageOutline(NOTICE_TABLE);
    const lines = numberedLines(text);

    expect(refs[0]).toBeNull();
    expect(lines.length).toBe(refs.length - 1);
    lines.forEach((line, i) => expect(line.trim().startsWith(`[${i + 1}]`)).toBe(true));
    expect(refs[1]).not.toBeNull();
    expect(lines[0]).toContain('"번호"');
    expect(refs[1]?.tagName).toBe("TH");
  });

  it("번호가 가리키는 요소는 그 텍스트의 가장 가까운 부모 요소다", () => {
    const { text, refs } = buildPageOutline(NOTICE_TABLE);
    const lines = numberedLines(text);
    const labelIdx = lines.findIndex((l) => l.includes('"접수기간:"')) + 1;
    const dateIdx = lines.findIndex((l) => l.includes('"2026-01-05"')) + 1;

    expect(refs[labelIdx]?.tagName).toBe("TD");
    expect(refs[dateIdx]?.tagName).toBe("SPAN");
    expect(refs[dateIdx]?.parentElement).toBe(refs[labelIdx]);
  });

  it("앵커는 경로와 텍스트를 함께 표기한다", () => {
    const { text, refs } = buildPageOutline(NOTICE_TABLE);
    const line = numberedLines(text).find((l) => l.includes("a→/notice/1234"));

    expect(line).toMatch(/\[\d+\] a→\/notice\/1234 "2026년 AI 바우처 지원사업 공고"/);
    const n = Number(/\[(\d+)\]/.exec(line ?? "")?.[1]);
    expect(refs[n]?.tagName).toBe("A");
  });

  it("img는 주소와 alt를 표기한다", () => {
    const { text, refs } = buildPageOutline(
      page('<ul><li><img src="/t/1.png" alt="행사 포스터"></li></ul>'),
    );
    const line = numberedLines(text).find((l) => l.includes("img→"));

    expect(line).toMatch(/\[\d+\] img→\/t\/1\.png "행사 포스터"/);
    expect(refs[Number(/\[(\d+)\]/.exec(line ?? "")?.[1])]?.tagName).toBe("IMG");
  });

  it("카드 전체를 감싼 앵커는 링크를 ref로 남기고 안쪽 텍스트에 각자 번호를 준다", () => {
    const { text, refs } = buildPageOutline(
      page('<a href="/e/1"><h3>행사 제목</h3><p>행사 요약</p></a>'),
    );
    const lines = numberedLines(text);

    expect(lines[0]).toMatch(/\[1\] a→\/e\/1 ""/);
    expect(refs[1]?.tagName).toBe("A");
    expect(lines[1]).toContain('"행사 제목"');
    expect(refs[2]?.tagName).toBe("H3");
    expect(refs[3]?.tagName).toBe("P");
  });

  it("들여쓰기로 DOM 깊이를 보인다", () => {
    const { text } = buildPageOutline(page("<div>가<div>나<div>다</div></div></div>"));
    const lines = numberedLines(text);
    const depthOf = (line: string): number => line.length - line.trimStart().length;

    expect(depthOf(lines[1] ?? "")).toBeGreaterThan(depthOf(lines[0] ?? ""));
    expect(depthOf(lines[2] ?? "")).toBeGreaterThan(depthOf(lines[1] ?? ""));
  });

  it("nav·footer 안의 노드에는 번호를 붙이지 않는다", () => {
    const { text, refs } = buildPageOutline(NOTICE_TABLE);
    const body = text.split(LINK_SECTION_HEADER)[0] ?? "";

    expect(body).not.toContain("저작권 안내");
    expect(body).not.toContain("사업공고");
    expect(refs.some((el) => el?.closest("nav, footer"))).toBe(false);
  });

  it("ref는 stripNoise를 거친 문서의 요소다 (applySpec과 같은 ref 공간)", () => {
    const outline = buildPageOutline(
      page(
        '<div class="gnb"><a href="/m">메뉴</a></div><ul><li><a href="/p/1">본문 공고 제목입니다</a></li></ul>',
      ),
    );

    expect(numberedLines(outline.text).join("\n")).not.toContain("메뉴");
    expect(outline.document.querySelector(".gnb")).toBeNull();
    for (const el of outline.refs.slice(1)) {
      expect(el && outline.document.contains(el)).toBe(true);
    }
  });

  it("svg는 지우지 않는다: 텍스트가 없는 svg는 줄을 만들지 않고, 있으면 실제 DOM의 노드로 번호를 받는다", () => {
    const { text, refs } = buildPageOutline(
      page("<div><svg><path d='M0 0'/></svg><p>본문</p><svg><text>아이콘 글자</text></svg></div>"),
    );
    const lines = numberedLines(text);

    expect(lines[0]).toContain('"본문"');
    expect(lines[1]).toContain('"아이콘 글자"');
    expect(refs[2]?.tagName.toLowerCase()).toBe("text");
  });

  // 불변식: 개요의 ref 공간은 applySpec이 보는 DOM(parseHTML + stripNoise)과 같아야 한다.
  // 개요가 요소를 더 지우면 nth-child 경로가 두 문서에서 다른 요소를 가리킨다.
  it("개요 문서는 stripNoise만 적용한 문서와 같은 요소 구조를 갖는다", () => {
    const html = page(`
      <nav><a href="/m">메뉴</a></nav>
      <div id="wrap">
        <svg class="ico"><path d="M0 0"/></svg>
        <p>첫째</p>
        <svg class="ico"><path d="M1 1"/></svg>
        <p>둘째</p>
      </div>
      <footer>푸터</footer>`);
    const outline = buildPageOutline(html);
    const { document: reference } = parseHTML(html);
    stripNoise(reference);

    expect(outline.document.querySelectorAll("svg").length).toBe(2);
    expect(outline.document.querySelectorAll("svg").length).toBe(
      reference.querySelectorAll("svg").length,
    );
    const position = (doc: Document, text: string): number => {
      const p = [...doc.querySelectorAll("p")].find((el) => el.textContent === text);
      return p ? [...(p.parentElement?.children ?? [])].indexOf(p) + 1 : -1;
    };
    expect(position(outline.document, "둘째")).toBe(4);
    expect(position(outline.document, "둘째")).toBe(position(reference, "둘째"));
    expect(outline.document.documentElement.outerHTML).toBe(reference.documentElement.outerHTML);
  });

  describe("ref 공간 불변식: 개요 문서 === parseHTML + stripNoise", () => {
    // applySpec이 보는 문서를 그대로 재현해 요소 구조 전체를 비교한다. 개요가 무엇이든
    // 추가로 지우거나 바꾸면(documentElement 접근자가 head를 만드는 것 포함) 여기서 깨진다.
    const expectSameDomAsApplySpec = (html: string): void => {
      const outline = buildPageOutline(html);
      const { document: reference } = parseHTML(html);
      stripNoise(reference);

      expect(outline.document.documentElement?.outerHTML ?? "").toBe(
        reference.documentElement?.outerHTML ?? "",
      );
      for (const el of outline.refs.slice(1)) {
        expect(el && outline.document.contains(el)).toBe(true);
      }
    };

    const KITCHEN_SINK = `<!doctype html><html lang="ko"><head><title>t</title><meta charset="utf-8">
      <style>.a{}</style><script>var x=1;</script></head><body>
      <!-- 주석 -->
      <header><a href="/">홈</a></header>
      <div class="gnb"><a href="/m">메뉴</a></div>
      <div class="menu-area"><a href="/m2">메뉴2</a></div>
      <aside>사이드</aside>
      <form action="/s"><input name="q"></form>
      <div aria-hidden="true">숨김</div>
      <script>var y=2;</script><style>.b{}</style><noscript>스크립트 필요</noscript>
      <iframe src="/f"></iframe>
      <main id="m">
        <svg class="ico"><path d="M0 0"/></svg>
        <p>줄<br>바꿈</p>
        <img src="/t/1.png" alt="포스터">
        <a href="/outer">바깥 <a href="/inner">안쪽</a></a>
        <ul><li><a href="/n/1"><span>제목</span><span>2026-01-05</span></a></li></ul>
      </main>
      <footer>푸터</footer></body></html>`;

    it.each([
      ["html/body 없는 조각", '<ul><li><a href="/p/1">조각 공고</a></li></ul>'],
      ["html 안에 body 없음", '<html><div><a href="/p/1">공고</a></div></html>'],
      ["head만 있음", "<html><head><title>빈 페이지</title></head></html>"],
      ["빈 body", "<html><body></body></html>"],
      ["빈 문자열", ""],
      ["노이즈 요소를 전부 담은 전체 문서", KITCHEN_SINK],
    ])("%s", (_name, html) => {
      expectSameDomAsApplySpec(html);
    });
  });

  it("앵커 안의 텍스트가 여러 조각이면 합치지 않고 각 조각이 자기 요소를 ref로 받는다", () => {
    const { text, refs } = buildPageOutline(
      page('<ul><li><a href="/n/1"><span class="t">제목입니다</span><span class="d">2026-01-05</span></a></li></ul>'),
    );
    const lines = numberedLines(text);

    expect(lines[0]).toMatch(/\[1\] a→\/n\/1 ""/);
    expect(refs[1]?.tagName).toBe("A");
    expect(lines[1]).toContain('"제목입니다"');
    expect(refs[2]?.className).toBe("t");
    expect(lines[2]).toContain('"2026-01-05"');
    expect(refs[3]?.className).toBe("d");
    expect(text).not.toContain("제목입니다2026");
  });

  it("텍스트 노드가 하나뿐인 앵커만 한 줄로 유지한다", () => {
    const single = numberedLines(buildPageOutline(page('<a href="/n/1">제목</a>')).text);
    const nestedEl = numberedLines(buildPageOutline(page('<a href="/n/1"><b>제목</b></a>')).text);

    expect(single).toHaveLength(1);
    expect(single[0]).toContain('a→/n/1 "제목"');
    // 텍스트를 가진 자식 요소가 있으면 그 요소가 ref여야 하므로 한 줄로 합치지 않는다.
    expect(nestedEl).toHaveLength(2);
  });

  it("href의 공백은 %20으로 바꾼다 (llm-read VISIBLE_TEXT의 \S* 전제)", () => {
    const { text } = buildPageOutline(page('<a href="/notice/view?q=a b  c">공고 제목</a>'));
    const line = numberedLines(text)[0] ?? "";

    expect(line).toContain("a→/notice/view?q=a%20b%20c ");
    expect(hintMatchesOutline(text, "공고 제목")).toBe(true);
    expect(hintMatchesOutline(text, "a%20b")).toBe(false);
  });

  it("링크 구역의 주소는 본문 줄 상한(120자)으로 절단하지 않는다", () => {
    const longHref = `/board/list.it?${"k=v&".repeat(60)}end`;
    const { text } = buildPageOutline(page(`<nav><a href="${longHref}">목록</a></nav><p>본문</p>`));

    expect(longHref.length).toBeGreaterThan(200);
    expect(text).toContain(`목록 → ${longHref}`);
  });

  it("링크 구역 줄은 [n] 형태의 링크 텍스트여도 번호 줄로 오인되지 않는다", () => {
    const { text } = buildPageOutline(page('<nav><a href="/g">[1] 안내</a></nav><p>본문</p>'));
    const section = text.split(LINK_SECTION_HEADER)[1] ?? "";

    expect(section).toContain("[1] 안내 → /g");
    expect(numberedLines(section)).toHaveLength(0);
    expect(hintMatchesOutline(text, "안내")).toBe(false);
  });

  it("개요 끝에 원본 문서의 링크 구역을 덧붙인다", () => {
    const { text } = buildPageOutline(NOTICE_TABLE);
    const section = text.split(LINK_SECTION_HEADER)[1] ?? "";

    expect(text.trimEnd().split("\n").some((l) => l === LINK_SECTION_HEADER)).toBe(true);
    expect(section).toContain("사업공고 → /notice/list.it");
    expect(section).toContain("알림마당 → /board/index.it");
    expect(/^\s*\[\d+\]/m.test(section)).toBe(false);
  });

  it("링크 구역의 라벨은 블록 자식 텍스트를 공백으로 잇는다", () => {
    const { text } = buildPageOutline(page('<a href="/e/1"><h3>행사 제목</h3><p>행사 요약</p></a>'));

    expect(text).toContain("행사 제목 행사 요약 → /e/1");
  });

  it("링크 구역은 40개로 제한하고 중복·비탐색 링크는 뺀다", () => {
    const anchors = Array.from({ length: 60 }, (_, i) => `<a href="/p/${i}">링크 ${i}</a>`).join("");
    const { text } = buildPageOutline(
      page(`<nav>${anchors}<a href="#">맨위</a><a href="javascript:go()">이동</a></nav><p>본문</p>`),
    );
    const section = (text.split(LINK_SECTION_HEADER)[1] ?? "").trim().split("\n");

    expect(LINK_SECTION_LIMIT).toBe(40);
    expect(section).toHaveLength(LINK_SECTION_LIMIT);
    expect(section.join("\n")).not.toContain("맨위");
  });

  it("텍스트 노드를 120자로 절단한다", () => {
    const { text } = buildPageOutline(page(`<p>${"가".repeat(300)}</p>`));
    const line = numberedLines(text)[0] ?? "";

    expect(TEXT_NODE_LIMIT).toBe(120);
    expect(line.trim()).toBe(`[1] "${"가".repeat(120)}"`);
  });

  it("48KB를 넘으면 뒤에서 절단하고 truncated를 true로 둔다", () => {
    const items = Array.from({ length: 2000 }, (_, i) => `<li>공고 ${i} ${"가".repeat(60)}</li>`).join("");
    const { text, refs, truncated } = buildPageOutline(
      page(`<nav><a href="/list">목록으로</a></nav><ul>${items}</ul>`),
    );
    const lines = numberedLines(text);

    expect(truncated).toBe(true);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(OUTLINE_MAX_BYTES);
    expect(lines.length).toBe(refs.length - 1);
    expect(lines[0]).toContain("공고 0 ");
    expect(text).not.toContain("공고 1999 ");
    // 절단되어도 링크 구역은 붙는다.
    expect(text).toContain(LINK_SECTION_HEADER);
    expect(text).toContain("목록으로 → /list");
  });

  it("절단이 없으면 truncated는 false다", () => {
    expect(buildPageOutline(NOTICE_TABLE).truncated).toBe(false);
  });

  it("빈 HTML에서 빈 개요와 refs=[null]을 반환한다", () => {
    const outline = buildPageOutline("");

    expect(outline.text).toBe("");
    expect(outline.refs).toEqual([null]);
    expect(outline.truncated).toBe(false);
  });

  it("html 태그 없는 조각도 처리한다", () => {
    const { text, refs } = buildPageOutline('<ul><li><a href="/p/1">조각 공고</a></li></ul>');

    expect(numberedLines(text)[0]).toMatch(/\[1\] a→\/p\/1 "조각 공고"/);
    expect(refs[1]?.tagName).toBe("A");
  });

  it("llm-read의 힌트 매칭이 번호 붙은 줄을 찾는다 (형식 결합)", () => {
    const { text } = buildPageOutline(NOTICE_TABLE);

    expect(hintMatchesOutline(text, "정보통신산업진흥원")).toBe(true);
    // 링크 구역에만 있는 텍스트는 가리킬 수 없으므로 힌트로 인정하지 않는다.
    expect(hintMatchesOutline(text, "알림마당")).toBe(false);
  });
});
