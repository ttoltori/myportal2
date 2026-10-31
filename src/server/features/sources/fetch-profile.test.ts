import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();

vi.mock("../../config/db", () => ({
  getDb: () => ({ query: queryMock }),
}));
// sources.ts가 끌어오는 수집·데스크 모듈은 이 테스트와 무관하고 env 검증을 유발한다.
vi.mock("../crawl/collector", () => ({ collectSource: vi.fn() }));
vi.mock("../desk/desk", () => ({ mapItem: vi.fn() }));

import type { CrawlSpec } from "../crawl/extract";
import type { FetchProfile } from "../crawl/analyze/profile";
import { loadFetchProfile, saveFetchProfile } from "./sources";
import { sourcesSql } from "./sources.sql";

const renderSpec = { strategy: "html", render: true } as unknown as CrawlSpec;
const staticSpec = { strategy: "html" } as unknown as CrawlSpec;

const stored: FetchProfile = {
  mode: "rendered",
  waitForSelector: "ul.list > li",
  settleMs: 4500,
  scrollToBottom: true,
  measuredReadyMs: 3000,
  measuredReadyBy: "selector",
  measuredAt: "2026-10-31T00:00:00.000Z",
};

beforeEach(() => {
  queryMock.mockReset();
});

describe("loadFetchProfile", () => {
  it("빈 jsonb면 spec.render로 mode를 유도한다", () => {
    expect(loadFetchProfile({ fetch_profile: {} }, renderSpec).mode).toBe("rendered");
    expect(loadFetchProfile({ fetch_profile: {} }, staticSpec).mode).toBe("static");
    expect(loadFetchProfile({ fetch_profile: null }, null).mode).toBe("static");
  });

  it("저장된 프로파일이 스키마에 맞으면 그대로 쓴다", () => {
    // spec.render와 달라도 저장된 값이 우선이어야 스펙 교체에 영향받지 않는다.
    expect(loadFetchProfile({ fetch_profile: stored }, staticSpec)).toEqual(stored);
  });

  it("저장된 프로파일이 스키마에 맞지 않으면 레거시 폴백으로 되돌린다", () => {
    // 운영 DB에 손으로 넣은 값이나 구버전 형태가 수집을 깨뜨리면 안 된다.
    for (const bad of [
      { mode: "browser", measuredAt: "x" },
      { mode: "rendered" },
      { mode: "rendered", settleMs: "빠르게", measuredAt: "x" },
      [],
      42,
      "not json {",
    ]) {
      const profile = loadFetchProfile({ fetch_profile: bad }, renderSpec);
      expect(profile.mode).toBe("rendered");
      expect(profile.settleMs).toBeUndefined();
    }
  });

  it("pg가 문자열로 돌려준 jsonb도 파싱한다", () => {
    expect(
      loadFetchProfile({ fetch_profile: JSON.stringify(stored) }, staticSpec),
    ).toEqual(stored);
  });
});

describe("saveFetchProfile", () => {
  it("sources.fetch_profile을 갱신하는 SQL을 파라미터 바인딩으로 실행한다", async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await saveFetchProfile("source-1", stored);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toBe(sourcesSql.updateFetchProfile);
    expect(sql).toContain("fetch_profile = $2");
    expect(params).toEqual(["source-1", JSON.stringify(stored)]);
  });

  it("tx가 주어지면 getDb 대신 tx로 실행한다", async () => {
    const txQuery = vi.fn().mockResolvedValue({ rows: [] });
    await saveFetchProfile("source-1", stored, { query: txQuery } as never);
    expect(txQuery).toHaveBeenCalledTimes(1);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe("sourcesSql.findById", () => {
  it("fetch_profile 컬럼을 조회한다", () => {
    expect(sourcesSql.findById).toContain("fetch_profile");
  });
});
