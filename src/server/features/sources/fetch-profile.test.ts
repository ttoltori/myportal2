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
import { isRenderedSource, loadFetchProfile, saveFetchProfile } from "./sources";
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
    expect(loadFetchProfile({ fetch_profile: {} }, renderSpec).profile.mode).toBe("rendered");
    expect(loadFetchProfile({ fetch_profile: {} }, staticSpec).profile.mode).toBe("static");
    expect(loadFetchProfile({ fetch_profile: null }, null).profile.mode).toBe("static");
  });

  it("저장된 프로파일이 스키마에 맞으면 그대로 쓴다", () => {
    // spec.render와 달라도 저장된 값이 우선이어야 스펙 교체에 영향받지 않는다.
    expect(loadFetchProfile({ fetch_profile: stored }, staticSpec).profile).toEqual(stored);
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
      const { profile } = loadFetchProfile({ fetch_profile: bad }, renderSpec);
      expect(profile.mode).toBe("rendered");
      expect(profile.settleMs).toBeUndefined();
    }
  });

  it("pg가 문자열로 돌려준 jsonb도 파싱한다", () => {
    expect(
      loadFetchProfile({ fetch_profile: JSON.stringify(stored) }, staticSpec).profile,
    ).toEqual(stored);
  });
});

describe("loadFetchProfile - fallback 판정", () => {
  // 로그를 남길지(corrupt)와 폴백이 쓰였는지가 한 곳에서 정해져야 어긋나지 않는다.
  const cases: [string, unknown, "none" | "empty" | "corrupt"][] = [
    ["정상 프로파일", stored, "none"],
    ["문자열로 온 정상 프로파일", JSON.stringify(stored), "none"],
    ["null", null, "empty"],
    ["undefined", undefined, "empty"],
    ["빈 객체", {}, "empty"],
    ["문자열 '{}'", "{}", "empty"],
    // 문자열 "null"은 파싱하면 실제 null과 같으므로 같은 분류여야 한다.
    ["문자열 'null'", "null", "empty"],
    // 빈 배열은 빈 프로파일이 아니라 형태가 틀린 값이다.
    ["빈 배열", [], "corrupt"],
    ["파싱 불가 문자열", "not json {", "corrupt"],
    ["잘못된 mode", { mode: "browser", measuredAt: "2026-10-31T00:00:00.000Z" }, "corrupt"],
    ["settleMs 0", { mode: "rendered", settleMs: 0, measuredAt: "2026-10-31T00:00:00.000Z" }, "corrupt"],
    ["숫자", 42, "corrupt"],
  ];

  it.each(cases)("%s -> %s 판정", (_name, value, expected) => {
    expect(loadFetchProfile({ fetch_profile: value }, renderSpec).fallback).toBe(expected);
  });

  it("폴백이어도 profile은 spec.render로 유도한 레거시 값이다", () => {
    expect(loadFetchProfile({ fetch_profile: [] }, renderSpec).profile.mode).toBe("rendered");
    expect(loadFetchProfile({ fetch_profile: [] }, staticSpec).profile.mode).toBe("static");
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

describe("isRenderedSource", () => {
  it("저장된 프로파일의 mode가 rendered면 스펙과 무관하게 true", () => {
    expect(isRenderedSource({ fetch_profile: stored }, staticSpec)).toBe(true);
    expect(isRenderedSource({ fetch_profile: stored }, null)).toBe(true);
  });

  it("저장된 프로파일이 static이면 spec.render가 있어도 false (프로파일이 우선)", () => {
    const staticProfile: FetchProfile = { mode: "static", measuredAt: stored.measuredAt };
    expect(isRenderedSource({ fetch_profile: staticProfile }, renderSpec)).toBe(false);
  });

  it("빈 프로파일 레거시 소스는 spec.render로 유도한다", () => {
    expect(isRenderedSource({ fetch_profile: {} }, renderSpec)).toBe(true);
    expect(isRenderedSource({ fetch_profile: {} }, staticSpec)).toBe(false);
    expect(isRenderedSource({ fetch_profile: null }, null)).toBe(false);
  });

  it("손상된 프로파일도 spec.render로 폴백한다", () => {
    expect(isRenderedSource({ fetch_profile: { mode: "bogus" } }, renderSpec)).toBe(true);
  });

  it("jsonb가 문자열로 와도 스펙을 읽는다", () => {
    expect(isRenderedSource({ fetch_profile: {} }, JSON.stringify(renderSpec))).toBe(true);
    expect(isRenderedSource({ fetch_profile: {} }, "{not json")).toBe(false);
  });
});
