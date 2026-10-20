import { describe, expect, it } from "vitest";
import {
  digestItems,
  digestPage,
  ITEMS_DIGEST_BYTES,
  PAGE_DIGEST_BYTES,
} from "./html-digest";

describe("digestItems / digestPage 공통 전처리", () => {
  it("script·style·주석을 제거한다", () => {
    const html =
      '<ul><script>alert(1)</script><style>.a{}</style><!--c--><li class="row">항목</li></ul>';
    const out = digestItems(html, "li.row");
    expect(out).toContain("항목");
    const page = digestPage(html);
    expect(page).not.toContain("alert");
    expect(page).not.toContain(".a{}");
    expect(page).not.toContain("<!--");
    expect(page).toContain("항목");
  });

  it("class·id·data-*·href를 보존한다", () => {
    const html =
      '<ul><li class="row" id="r1" data-pk="7"><a href="/v/7">제목</a></li></ul>';
    const out = digestItems(html, "li.row");
    expect(out).toContain('class="row"');
    expect(out).toContain('id="r1"');
    expect(out).toContain('data-pk="7"');
    expect(out).toContain('href="/v/7"');
  });

  it("style·onclick 속성은 제거한다", () => {
    const html =
      '<ul><li class="row" style="color:red" onclick="go(1)">x</li></ul>';
    const out = digestItems(html, "li.row");
    expect(out).not.toContain("color:red");
    expect(out).not.toContain("go(1)");
    expect(out).toContain("x");
  });

  it("80자를 넘는 텍스트 노드를 절단한다", () => {
    const long = "가".repeat(200);
    const html = `<ul><li class="row">${long}</li></ul>`;
    const out = digestItems(html, "li.row");
    expect(out).toContain("…");
    expect(out).not.toContain(long);
  });
});

describe("digestItems", () => {
  it("문서 순서 앞 3개 항목만 반환한다", () => {
    const lis = Array.from(
      { length: 10 },
      (_, i) => `<li class="row">항목${i + 1}</li>`,
    ).join("");
    const out = digestItems(`<ul>${lis}</ul>`, "li.row");
    expect(out).toContain("항목1");
    expect(out).toContain("항목2");
    expect(out).toContain("항목3");
    expect(out).not.toContain("항목4");
  });

  it("잘못된 문법의 셀렉터에 빈 문자열을 반환한다", () => {
    expect(digestItems("<ul><li>a</li></ul>", "div[[")).toBe("");
  });

  it("매칭이 없으면 빈 문자열을 반환한다", () => {
    expect(digestItems("<ul><li>a</li></ul>", ".none")).toBe("");
  });

  it("총 크기 상한을 넘지 않는다", () => {
    const big = Array.from(
      { length: 100 },
      (_, i) => `<span class="c${i}">${"x".repeat(60)}</span>`,
    ).join("");
    const lis = Array.from({ length: 3 }, () => `<li class="row">${big}</li>`).join("");
    const out = digestItems(`<ul>${lis}</ul>`, "li.row");
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(ITEMS_DIGEST_BYTES);
  });
});

describe("digestPage", () => {
  it("header·nav·footer·aside를 제외한다", () => {
    const html =
      "<body><nav>메뉴</nav><main><li>본문항목</li></main><footer>푸터</footer></body>";
    const out = digestPage(html);
    expect(out).not.toContain("메뉴");
    expect(out).not.toContain("푸터");
    expect(out).toContain("본문항목");
  });

  it("크기 상한을 넘지 않는다", () => {
    const body = Array.from(
      { length: 2000 },
      (_, i) => `<li class="row r${i}">${"y".repeat(60)}</li>`,
    ).join("");
    const out = digestPage(`<body><main><ul>${body}</ul></main></body>`);
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(PAGE_DIGEST_BYTES);
  });
});
