import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CrawlSpec } from "../extract";

vi.mock("./llm-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./llm-client")>();
  return { ...actual, chatJson: vi.fn() };
});

import {
  inferFields,
  inferListAndFields,
  validateInferredFields,
  type InferredField,
  type LlmModelConfig,
} from "./field-inference";
import { chatJson, LlmError } from "./llm-client";

const PAGE = "https://x.kr/list";
const MODEL: LlmModelConfig = {
  baseUrl: "https://api.test/v1",
  apiKey: "sk-x",
  model: "gpt-4o-mini",
};

function field(over: Partial<InferredField> & { key: string }): InferredField {
  return {
    label: over.key,
    selector: `.${over.key}`,
    type: "text",
    role: "none",
    ...over,
  };
}

// li.row N개. 앞 3개만 span.rare를 가진다 (20건 기준 채움률 15%).
function listHtml(count = 20): string {
  const items = Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    const rare = n <= 3 ? `<span class="rare">희귀</span>` : "";
    return `<li class="row"><a href="/v/${n}">공고 제목 ${n}</a><span class="org">기관${n}</span>${rare}</li>`;
  });
  return `<html><body><ul>${items.join("")}</ul></body></html>`;
}

const baseSpec: CrawlSpec = { strategy: "html", itemSelector: "li.row", fields: {} };

describe("validateInferredFields", () => {
  const html = listHtml();

  it("유효한 필드를 spec.fields에 병합하고 메타를 보존한다", () => {
    const r = validateInferredFields(
      html, PAGE, baseSpec,
      [field({ key: "org", label: "주최기관", selector: ".org" })],
      "enrich",
    );
    expect(r).not.toBeNull();
    expect(r!.accepted).toHaveLength(1);
    expect(r!.spec.fields!.org.label).toBe("주최기관");
    expect(r!.spec.fieldSource).toBe("llm");
    expect(r!.rows[0].attrs.org).toBe("기관1");
  });

  it("문법이 깨진 셀렉터는 그 필드만 버린다", () => {
    const r = validateInferredFields(
      html, PAGE, baseSpec,
      [field({ key: "org" }), field({ key: "bad", selector: "div[[" })],
      "enrich",
    );
    expect(r!.accepted.map((f) => f.key)).toEqual(["org"]);
    expect(r!.rejected.map((x) => x.key)).toContain("bad");
    expect(r!.spec.fields!.bad).toBeUndefined();
  });

  it("채움률 30% 미만인 필드는 버린다", () => {
    const r = validateInferredFields(
      html, PAGE, baseSpec,
      [field({ key: "rare" })],
      "enrich",
    );
    expect(r).toBeNull();
  });

  it("채움률 미달 필드만 버리고 나머지는 채택하며 사유를 남긴다", () => {
    const r = validateInferredFields(
      html, PAGE, baseSpec,
      [field({ key: "org" }), field({ key: "rare" })],
      "enrich",
    );
    expect(r!.accepted.map((f) => f.key)).toEqual(["org"]);
    expect(r!.rejected).toEqual([
      { key: "rare", reason: expect.stringContaining("채움률") },
    ]);
    expect(r!.rows[0].attrs.rare).toBeUndefined();
  });

  it("key가 고정 필드와 충돌하면 그 필드만 버린다", () => {
    const r = validateInferredFields(
      html, PAGE, baseSpec,
      [field({ key: "title", selector: ".org" }), field({ key: "org" })],
      "enrich",
    );
    expect(r!.accepted.map((f) => f.key)).toEqual(["org"]);
    expect(r!.rejected.map((x) => x.key)).toContain("title");
  });

  it("role이 title/link/published면 none으로 강제한다", () => {
    const r = validateInferredFields(
      html, PAGE, baseSpec,
      [field({ key: "org", role: "title" })],
      "enrich",
    );
    expect(r!.accepted[0].role).toBe("none");
    expect(r!.spec.fields!.org.role).toBe("none");
  });

  it("중복 key는 첫 번째만 채택한다", () => {
    const r = validateInferredFields(
      html, PAGE, baseSpec,
      [field({ key: "org", selector: ".org" }), field({ key: "org", selector: ".other" })],
      "enrich",
    );
    expect(r!.accepted).toHaveLength(1);
    expect(r!.accepted[0].selector).toBe(".org");
    expect(r!.rejected).toEqual([
      { key: "org", reason: expect.stringContaining("중복") },
    ]);
  });

  it("enrich 모드에서 통과 필드가 0개면 null을 반환한다", () => {
    const r = validateInferredFields(
      html, PAGE, baseSpec,
      [field({ key: "nope", selector: ".nothing" })],
      "enrich",
    );
    expect(r).toBeNull();
  });

  it("rescue 모드에서 itemSelector 매칭이 3건 미만이면 null을 반환한다", () => {
    const twoItems = `<html><body><ul>
      <li class="only-two"><a href="/a">공고 제목 가</a><span class="org">기관1</span></li>
      <li class="only-two"><a href="/b">공고 제목 나</a><span class="org">기관2</span></li>
    </ul></body></html>`;
    const r = validateInferredFields(
      twoItems, PAGE,
      { strategy: "html", itemSelector: ".only-two", fields: {} },
      [field({ key: "org" })],
      "rescue",
    );
    expect(r).toBeNull();
  });

  it("rescue 모드에서 title 채움률 80% 미만이면 null을 반환한다", () => {
    // 20건 중 10건만 앵커·제목을 가진다 (나머지는 제목을 만들 수 없는 항목).
    const items = Array.from({ length: 20 }, (_, i) =>
      i < 10
        ? `<li class="row"><a href="/v/${i}">공고 제목 ${i}</a><span class="org">기관${i}</span></li>`
        : `<li class="row"><span class="org">${i}</span></li>`,
    );
    const half = `<html><body><ul>${items.join("")}</ul></body></html>`;
    const r = validateInferredFields(half, PAGE, baseSpec, [field({ key: "org" })], "rescue");
    expect(r).toBeNull();
  });

  it("rescue 모드에서 목록이 유효하면 필드와 함께 반환한다", () => {
    const r = validateInferredFields(html, PAGE, baseSpec, [field({ key: "org" })], "rescue");
    expect(r!.rows).toHaveLength(20);
    expect(r!.accepted).toHaveLength(1);
  });

  // 제목·링크만 있는 게시판이 구제 대상의 다수다. 필드를 못 건졌다고 목록 추출까지
  // 버리면 그 사이트는 끝까지 상세 페이지로 남는다.
  it("rescue 모드는 통과 필드가 0개여도 목록이 유효하면 반환한다", () => {
    const r = validateInferredFields(
      html, PAGE, baseSpec,
      [field({ key: "nope", selector: ".nothing" })],
      "rescue",
    );
    expect(r).not.toBeNull();
    expect(r!.accepted).toHaveLength(0);
    expect(r!.rows).toHaveLength(20);
    expect(r!.rejected.map((x) => x.key)).toContain("nope");
  });

  it("enrich 모드는 rows가 3건 미만이어도 필드만 검증한다", () => {
    const r = validateInferredFields(
      listHtml(2), PAGE, baseSpec,
      [field({ key: "org" })],
      "enrich",
    );
    expect(r).not.toBeNull();
    expect(r!.accepted).toHaveLength(1);
    expect(r!.rows).toHaveLength(2);
  });

  it("baseSpec의 기존 필드를 보존하고 입력 스펙을 변경하지 않는다", () => {
    const spec: CrawlSpec = {
      ...baseSpec,
      fields: { existing: { selector: ".org" } },
    };
    const r = validateInferredFields(html, PAGE, spec, [field({ key: "org" })], "enrich");
    expect(Object.keys(r!.spec.fields!).sort()).toEqual(["existing", "org"]);
    expect(Object.keys(spec.fields!)).toEqual(["existing"]);
    expect(spec.fieldSource).toBeUndefined();
  });
});

describe("inferFields / inferListAndFields", () => {
  const chatJsonMock = vi.mocked(chatJson);

  beforeEach(() => {
    chatJsonMock.mockReset();
    chatJsonMock.mockResolvedValue({
      data: { fields: [], itemSelector: "li.row" },
      promptTokens: 1,
      completionTokens: 1,
      durationMs: 1,
    });
  });

  it("inferFields는 축약된 항목 HTML을 user 프롬프트에 담아 호출한다", async () => {
    await inferFields(listHtml(5), "li.row", MODEL);
    expect(chatJsonMock).toHaveBeenCalledTimes(1);
    const opts = chatJsonMock.mock.calls[0][1];
    expect(opts.user).toContain('class="org"');
    expect(opts.model).toBe("gpt-4o-mini");
    expect(opts.apiKey).toBe("sk-x");
    expect(opts.baseUrl).toBe("https://api.test/v1");
  });

  it("inferFields는 itemSelector 매칭이 없으면 호출하지 않고 LlmError를 던진다", async () => {
    const err = await inferFields(listHtml(5), ".none", MODEL).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).kind).toBe("schema");
    expect((err as LlmError).message).toBe("추론할 항목 HTML이 없습니다");
    expect(chatJsonMock).not.toHaveBeenCalled();
  });

  it("inferFields는 문법이 깨진 itemSelector에도 호출하지 않고 LlmError를 던진다", async () => {
    await expect(inferFields(listHtml(5), "div[[", MODEL)).rejects.toBeInstanceOf(LlmError);
    expect(chatJsonMock).not.toHaveBeenCalled();
  });

  it("inferListAndFields는 축약된 페이지 전체를 담아 호출한다", async () => {
    const page = `<html><body><nav>메뉴항목</nav><main><ul>
      <li class="row"><a href="/v/1">본문항목 하나</a></li></ul></main></body></html>`;
    await inferListAndFields(page, MODEL);
    const opts = chatJsonMock.mock.calls[0][1];
    expect(opts.user).toContain("본문항목 하나");
    expect(opts.user).not.toContain("메뉴항목");
  });

  it("inferListAndFields는 본문이 비어 있으면 호출하지 않고 LlmError를 던진다", async () => {
    await expect(inferListAndFields("", MODEL)).rejects.toBeInstanceOf(LlmError);
    expect(chatJsonMock).not.toHaveBeenCalled();
  });

  it("두 프롬프트 모두 제목·링크·게시일을 제외하라고 지시한다", async () => {
    await inferFields(listHtml(5), "li.row", MODEL);
    await inferListAndFields(listHtml(5), MODEL);
    for (const call of chatJsonMock.mock.calls) {
      expect(call[1].system).toContain("제목·링크·게시일은 이미 처리되므로 제외");
    }
    expect(chatJsonMock.mock.calls[1][1].system).toContain("itemSelector");
  });
});
