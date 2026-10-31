import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// chatJson을 실제 구현으로 두고 호출만 감시한다. 스키마 검증·재시도·timeout 변환은
// 전송 계층의 동작이므로 fetch만 대체해 그대로 확인한다.
vi.mock("../llm/llm-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/llm-client")>();
  return { ...actual, chatJson: vi.fn(actual.chatJson) };
});

import { chatJson, LlmError } from "../llm/llm-client";
import {
  hintMatchesOutline,
  readPage,
  readPageRepair,
  type LlmModelConfig,
} from "./llm-read";

const PAGE = "https://x.kr/notice/list";
const MODEL: LlmModelConfig = {
  baseUrl: "https://api.test/v1",
  apiKey: "sk-x",
  model: "gpt-4o-mini",
};

const OUTLINE = [
  `  [11] "번호 제목 기관 접수기간 상태"`,
  `    [12] a→/notice/1234 "2026년 AI 바우처 지원사업 공고"`,
  `    [13] "정보통신산업진흥원"`,
  `    [14] "2026-01-05 ~ 2026-02-03"`,
  `    [15] "접수중"`,
  `    [16] a→/notice/1233 "데이터 활용 기업 모집"`,
  `    [17] "한국데이터산업진흥원"`,
  `── 페이지 내 링크 (목록 후보 판단용) ──`,
  `사업공고 → /notice/list.it`,
].join("\n");

const SUGGESTED = { displayName: "x 공고", categoryPath: ["지원사업"], tagNames: ["공고"] };

interface BodyItem {
  titleRef: number;
  titleText: string;
  linkRef: number;
  fields: { key: string; label: string; type: string; role: string; ref: number; text: string }[];
}

function validItem(): BodyItem {
  return {
    titleRef: 12,
    titleText: "2026년 AI 바우처 지원사업 공고",
    linkRef: 12,
    fields: [
      {
        key: "period",
        label: "접수기간",
        type: "date_range",
        role: "deadline",
        ref: 14,
        text: "2026-01-05 ~ 2026-02-03",
      },
    ],
  };
}

function validBody(over: Record<string, unknown> = {}) {
  return {
    pageKind: "list",
    pageTitle: "공고 목록",
    items: [validItem()],
    suggested: SUGGESTED,
    ...over,
  };
}

function completion(content: unknown) {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(content) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
    { status: 200 },
  );
}

const fetchMock = vi.fn<typeof fetch>();
const chatJsonMock = vi.mocked(chatJson);

function lastUserPrompt(): string {
  const init = fetchMock.mock.calls.at(-1)![1] as RequestInit;
  const body = JSON.parse(init.body as string) as {
    messages: { role: string; content: string }[];
  };
  return body.messages.find((m) => m.role === "user")!.content;
}

beforeEach(() => {
  fetchMock.mockReset();
  chatJsonMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readPage", () => {
  it("응답을 스키마로 검증해 돌려준다", async () => {
    fetchMock.mockResolvedValueOnce(completion(validBody()));
    const r = await readPage({ outlineText: OUTLINE, pageUrl: PAGE, model: MODEL });
    expect(r.data.pageKind).toBe("list");
    expect(r.data.items[0].titleRef).toBe(12);
    expect(r.data.items[0].fields[0].role).toBe("deadline");
    expect(r.promptTokens).toBe(10);
    expect(lastUserPrompt()).toContain(PAGE);
    expect(lastUserPrompt()).toContain('[12] a→/notice/1234 "2026년 AI 바우처 지원사업 공고"');
  });

  it("긴 입력에 맞춰 토큰·timeout 한도를 올려 호출한다", async () => {
    fetchMock.mockResolvedValueOnce(completion(validBody()));
    await readPage({ outlineText: OUTLINE, pageUrl: PAGE, model: MODEL });
    const opts = chatJsonMock.mock.calls[0][1];
    expect(opts.maxTokens).toBe(8000);
    expect(opts.timeoutMs).toBe(40_000);
    expect(opts.temperature).toBe(0);
    expect(opts.model).toBe("gpt-4o-mini");
    expect(opts.apiKey).toBe("sk-x");
  });

  it("pageKind가 enum 밖이면 재시도 후 LlmError(schema)를 던진다", async () => {
    fetchMock.mockImplementation(async () => completion(validBody({ pageKind: "gallery" })));
    const err = await readPage({ outlineText: OUTLINE, pageUrl: PAGE, model: MODEL }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).kind).toBe("schema");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("items가 빈 배열이어도 성공으로 받는다", async () => {
    fetchMock.mockResolvedValueOnce(
      completion({
        pageKind: "detail",
        pageTitle: "상세",
        items: [],
        listCandidates: [{ label: "사업공고", url: "/notice/list.it" }],
        suggested: SUGGESTED,
      }),
    );
    const r = await readPage({ outlineText: OUTLINE, pageUrl: PAGE, model: MODEL });
    expect(r.data.items).toEqual([]);
    expect(r.data.listCandidates).toEqual([{ label: "사업공고", url: "/notice/list.it" }]);
  });

  it("fields의 key가 정규식에 맞지 않으면 거부한다", async () => {
    const item = validItem();
    item.fields[0].key = "접수 기간";
    fetchMock.mockImplementation(async () => completion(validBody({ items: [item] })));
    await expect(
      readPage({ outlineText: OUTLINE, pageUrl: PAGE, model: MODEL }),
    ).rejects.toMatchObject({ kind: "schema" });
  });

  it("ref가 0이면 거부한다", async () => {
    const item = validItem();
    item.titleRef = 0;
    fetchMock.mockImplementation(async () => completion(validBody({ items: [item] })));
    await expect(
      readPage({ outlineText: OUTLINE, pageUrl: PAGE, model: MODEL }),
    ).rejects.toMatchObject({ kind: "schema" });
  });

  it("titleText가 없으면 거부한다", async () => {
    const { titleText: _omit, ...item } = validItem();
    fetchMock.mockImplementation(async () => completion(validBody({ items: [item] })));
    await expect(
      readPage({ outlineText: OUTLINE, pageUrl: PAGE, model: MODEL }),
    ).rejects.toMatchObject({ kind: "schema" });
  });

  it("필드의 text가 없으면 거부한다", async () => {
    const item = validItem();
    const { text: _omit, ...field } = item.fields[0];
    fetchMock.mockImplementation(async () =>
      completion(validBody({ items: [{ ...item, fields: [field] }] })),
    );
    await expect(
      readPage({ outlineText: OUTLINE, pageUrl: PAGE, model: MODEL }),
    ).rejects.toMatchObject({ kind: "schema" });
  });

  it("text가 500자를 넘으면 거부한다", async () => {
    const item = validItem();
    item.fields[0].text = "가".repeat(501);
    fetchMock.mockImplementation(async () => completion(validBody({ items: [item] })));
    await expect(
      readPage({ outlineText: OUTLINE, pageUrl: PAGE, model: MODEL }),
    ).rejects.toMatchObject({ kind: "schema" });
  });

  // 이 문구들이 빠지면 번호가 어긋났을 때 값으로 노드를 재탐색하는 폴백이 무력해진다.
  it("시스템 프롬프트가 text 작성 규칙을 담는다", async () => {
    fetchMock.mockResolvedValueOnce(completion(validBody()));
    await readPage({ outlineText: OUTLINE, pageUrl: PAGE, model: MODEL });
    const system = chatJsonMock.mock.calls[0][1].system;
    expect(system).toContain("따옴표 안에 있는 텍스트만");
    expect(system).toContain("그대로(요약·가공 없이)");
    expect(system).toContain("titleText와 필드의 text");
    expect(system).toContain("개요에 없는 번호는 쓰지 않습니다");
    expect(system).toContain("링크 텍스트");
    expect(system).toContain("대체 텍스트");
    expect(system).toContain("500자");
  });

  it("model의 추가 속성은 요청 옵션에 싣지 않는다", async () => {
    fetchMock.mockResolvedValueOnce(completion(validBody()));
    const model = { ...MODEL, extra: "leak" } as LlmModelConfig;
    await readPage({ outlineText: OUTLINE, pageUrl: PAGE, model });
    expect(chatJsonMock.mock.calls[0][1]).not.toHaveProperty("extra");
  });

  it("항목이 13개 이상이면 거부한다", async () => {
    fetchMock.mockImplementation(async () =>
      completion(validBody({ items: Array.from({ length: 13 }, () => validItem()) })),
    );
    await expect(
      readPage({ outlineText: OUTLINE, pageUrl: PAGE, model: MODEL }),
    ).rejects.toMatchObject({ kind: "schema" });
  });

  it("개요에 있는 힌트는 프롬프트에 단서 문장과 표시를 넣는다", async () => {
    fetchMock.mockResolvedValueOnce(completion(validBody()));
    await readPage({ outlineText: OUTLINE, pageUrl: PAGE, hint: "AI 바우처", model: MODEL });
    const user = chatJsonMock.mock.calls[0][1].user;
    expect(user).toContain('사용자가 지정한 목록 항목의 단서: "AI 바우처"');
    expect(user).toContain(`"2026년 AI 바우처 지원사업 공고"  ◀단서`);
    // 단서와 무관한 줄에는 표시를 붙이지 않는다.
    expect(user).not.toContain(`"데이터 활용 기업 모집"  ◀단서`);
  });

  it("힌트가 개요에 없으면 단서 문장을 넣지 않는다", async () => {
    fetchMock.mockResolvedValueOnce(completion(validBody()));
    await readPage({ outlineText: OUTLINE, pageUrl: PAGE, hint: "존재하지않는문구", model: MODEL });
    const user = chatJsonMock.mock.calls[0][1].user;
    expect(user).not.toContain("단서");
    expect(user).not.toContain("존재하지않는문구");
  });

  it("힌트가 없으면 단서 문장을 넣지 않는다", async () => {
    fetchMock.mockResolvedValueOnce(completion(validBody()));
    await readPage({ outlineText: OUTLINE, pageUrl: PAGE, model: MODEL });
    expect(chatJsonMock.mock.calls[0][1].user).not.toContain("단서");
  });

  it("timeout은 LlmError(timeout)으로 전파된다", async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
    const err = await readPage({ outlineText: OUTLINE, pageUrl: PAGE, model: MODEL }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).kind).toBe("timeout");
  });
});

describe("hintMatchesOutline", () => {
  it("번호가 붙은 줄에 있으면 true다", () => {
    expect(hintMatchesOutline(OUTLINE, "AI 바우처")).toBe(true);
  });

  it("공백과 대소문자 차이는 무시한다", () => {
    expect(hintMatchesOutline(OUTLINE, "  ai   바우처 ")).toBe(true);
  });

  it("힌트가 개요에 없으면 false다", () => {
    expect(hintMatchesOutline(OUTLINE, "존재하지않는문구")).toBe(false);
  });

  it("번호가 없는 링크 구역에만 있는 문구는 false다", () => {
    expect(hintMatchesOutline(OUTLINE, "list.it")).toBe(false);
  });

  it("짧은 힌트가 번호나 URL에는 매칭되지 않는다", () => {
    expect(hintMatchesOutline(OUTLINE, "12")).toBe(false); // [12]
    expect(hintMatchesOutline(OUTLINE, "1234")).toBe(false); // href
    expect(hintMatchesOutline(OUTLINE, "notice")).toBe(false); // href
    expect(hintMatchesOutline(OUTLINE, "→")).toBe(false);
  });

  it("번호나 URL에만 걸리는 줄에는 단서 표시를 붙이지 않는다", async () => {
    fetchMock.mockResolvedValueOnce(completion(validBody()));
    await readPage({ outlineText: OUTLINE, pageUrl: PAGE, hint: "1234", model: MODEL });
    const user = chatJsonMock.mock.calls[0][1].user;
    expect(user).not.toContain("◀단서");
    expect(user).not.toContain("단서:");
  });

  it("빈 힌트는 false다", () => {
    expect(hintMatchesOutline(OUTLINE, "   ")).toBe(false);
  });
});

describe("readPageRepair", () => {
  it("시도한 셀렉터와 추출된 제목을 프롬프트에 넣는다", async () => {
    fetchMock.mockResolvedValueOnce(completion(validBody()));
    await readPageRepair({
      outlineText: OUTLINE,
      pageUrl: PAGE,
      model: MODEL,
      attempted: {
        itemSelector: "ul.menu > li",
        extractedTitles: ["회사소개", "사업안내", "고객센터", "넷째는 잘린다"],
      },
    });
    const user = chatJsonMock.mock.calls[0][1].user;
    expect(user).toContain("ul.menu > li");
    expect(user).toContain("- 회사소개");
    expect(user).toContain("- 고객센터");
    expect(user).not.toContain("넷째는 잘린다");
    expect(user).toContain("당신이 보고한 항목과 다릅니다");
    expect(user).toContain(PAGE);
    expect(user).toContain("페이지 개요:");
  });

  it("추출된 제목의 개행은 한 줄로 합치고 셀렉터는 길이를 제한한다", async () => {
    fetchMock.mockResolvedValueOnce(completion(validBody()));
    await readPageRepair({
      outlineText: OUTLINE,
      pageUrl: PAGE,
      model: MODEL,
      attempted: {
        itemSelector: "li" + ".x".repeat(300),
        extractedTitles: ["첫째 줄\n- 가짜 항목\n   셋째 줄"],
      },
    });
    const user = chatJsonMock.mock.calls[0][1].user;
    expect(user).toContain("- 첫째 줄 - 가짜 항목 셋째 줄");
    expect(user).not.toContain("\n- 가짜 항목");
    expect(user).not.toContain(".x".repeat(150));
  });

  it("추출된 제목이 없으면 그 사실을 알린다", async () => {
    fetchMock.mockResolvedValueOnce(completion(validBody()));
    await readPageRepair({
      outlineText: OUTLINE,
      pageUrl: PAGE,
      model: MODEL,
      attempted: { itemSelector: "div.none", extractedTitles: [] },
    });
    expect(chatJsonMock.mock.calls[0][1].user).toContain("추출된 항목이 없습니다");
  });

  it("힌트가 개요에 있으면 보수 호출에도 단서를 넣는다", async () => {
    fetchMock.mockResolvedValueOnce(completion(validBody()));
    await readPageRepair({
      outlineText: OUTLINE,
      pageUrl: PAGE,
      hint: "데이터 활용",
      model: MODEL,
      attempted: { itemSelector: "li", extractedTitles: ["x"] },
    });
    expect(chatJsonMock.mock.calls[0][1].user).toContain("◀단서");
  });

  it("응답은 readPage와 같은 스키마로 검증한다", async () => {
    fetchMock.mockImplementation(async () => completion(validBody({ pageKind: "x" })));
    await expect(
      readPageRepair({
        outlineText: OUTLINE,
        pageUrl: PAGE,
        model: MODEL,
        attempted: { itemSelector: "li", extractedTitles: [] },
      }),
    ).rejects.toMatchObject({ kind: "schema" });
  });
});

describe("timeoutMs 인자", () => {
  it("readPage에 timeoutMs를 넘기면 그 값이 chatJson의 시도당 timeout이 된다", async () => {
    fetchMock.mockResolvedValueOnce(completion(validBody()));
    await readPage({ outlineText: OUTLINE, pageUrl: PAGE, model: MODEL, timeoutMs: 25_000 });
    expect(chatJsonMock.mock.calls[0][1].timeoutMs).toBe(25_000);
  });

  it("readPageRepair에도 timeoutMs가 전달된다", async () => {
    fetchMock.mockResolvedValueOnce(completion(validBody()));
    await readPageRepair({
      outlineText: OUTLINE,
      pageUrl: PAGE,
      model: MODEL,
      attempted: { itemSelector: "div.none", extractedTitles: [] },
      timeoutMs: 18_000,
    });
    expect(chatJsonMock.mock.calls[0][1].timeoutMs).toBe(18_000);
  });

  it("readPageRepair도 생략하면 기본 40초다", async () => {
    fetchMock.mockResolvedValueOnce(completion(validBody()));
    await readPageRepair({
      outlineText: OUTLINE,
      pageUrl: PAGE,
      model: MODEL,
      attempted: { itemSelector: "div.none", extractedTitles: [] },
    });
    expect(chatJsonMock.mock.calls[0][1].timeoutMs).toBe(40_000);
  });
});
