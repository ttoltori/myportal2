import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { LlmError, chatJson } from "./llm-client";

const schema = z.object({ fields: z.array(z.object({ key: z.string() })) });
const opts = {
  baseUrl: "https://api.test/v1",
  apiKey: "sk-x",
  model: "m",
  system: "s",
  user: "u",
};
const VALID = JSON.stringify({ fields: [{ key: "deadline" }] });

function okResponse(content: string, usage?: { prompt_tokens: number; completion_tokens: number }) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }], usage }),
  };
}

let fetchMock: ReturnType<typeof vi.fn>;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function catchError(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("rejects 되어야 한다");
}

describe("chatJson", () => {
  it("유효한 JSON 응답을 파싱해 반환한다", async () => {
    fetchMock.mockResolvedValueOnce(okResponse(VALID));
    const r = await chatJson(schema, opts);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.data.fields[0].key).toBe("deadline");
  });

  it("응답의 usage 토큰 수를 결과에 담는다", async () => {
    fetchMock.mockResolvedValueOnce(okResponse(VALID, { prompt_tokens: 120, completion_tokens: 45 }));
    const r = await chatJson(schema, opts);
    expect(r.promptTokens).toBe(120);
    expect(r.completionTokens).toBe(45);
  });

  it("usage가 없으면 토큰 수는 null이다", async () => {
    fetchMock.mockResolvedValueOnce(okResponse(VALID));
    const r = await chatJson(schema, opts);
    expect(r.promptTokens).toBeNull();
    expect(r.completionTokens).toBeNull();
  });

  it("비JSON 응답이면 1회 재시도하고, 재시도가 성공하면 데이터를 반환한다", async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse("이건 JSON이 아닙니다"))
      .mockResolvedValueOnce(okResponse(VALID));
    const r = await chatJson(schema, opts);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(r.data.fields[0].key).toBe("deadline");
  });

  it("스키마에 맞지 않는 JSON이면 1회 재시도한다", async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse('{"wrong":1}'))
      .mockResolvedValueOnce(okResponse(VALID));
    const r = await chatJson(schema, opts);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(r.data.fields[0].key).toBe("deadline");
  });

  it("재시도도 실패하면 kind='schema'인 LlmError를 던진다", async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse("not json"))
      .mockResolvedValueOnce(okResponse("still not json"));
    const err = await catchError(chatJson(schema, opts));
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).kind).toBe("schema");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("HTTP 500이면 재시도하지 않고 kind='http'인 LlmError를 던진다", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    const err = await catchError(chatJson(schema, opts));
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).kind).toBe("http");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("요청 본문에 모델·temperature 0·json_object 응답 형식이 들어간다", async () => {
    fetchMock.mockResolvedValueOnce(okResponse(VALID));
    await chatJson(schema, opts);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.test/v1/chat/completions");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("m");
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(2000);
    expect(body.response_format.type).toBe("json_object");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-x");
  });

  it("AbortError는 kind='timeout'인 LlmError로 변환된다", async () => {
    fetchMock.mockRejectedValueOnce(new DOMException("", "AbortError"));
    const err = await catchError(chatJson(schema, opts));
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).kind).toBe("timeout");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("API 키가 오류 메시지에 노출되지 않는다", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: "Incorrect API key provided: sk-x" } }),
    });
    const err = await catchError(chatJson(schema, opts));
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).message).not.toContain("sk-x");
  });
});
