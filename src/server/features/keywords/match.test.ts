import { describe, expect, it } from "vitest";
import { ruleAppliesToText, type KeywordRuleRow } from "./match";

function rule(partial: Partial<KeywordRuleRow>): KeywordRuleRow {
  return {
    id: "r1",
    user_id: "u1",
    name: "test",
    keywords: [],
    exclude: [],
    scope: "all",
    scope_id: null,
    action: "emphasize",
    ...partial,
  };
}

describe("ruleAppliesToText", () => {
  it("matches keywords case-insensitively, OR semantics", () => {
    const r = rule({ keywords: ["휴머노이드", "Robot"] });
    expect(ruleAppliesToText(r, "새로운 휴머노이드 발표")).toBe(true);
    expect(ruleAppliesToText(r, "a ROBOT arm")).toBe(true);
    expect(ruleAppliesToText(r, "관련 없는 글")).toBe(false);
  });

  it("partial match catches particles attached to keywords", () => {
    const r = rule({ keywords: ["휴머노이드"] });
    expect(ruleAppliesToText(r, "휴머노이드가 걷는다")).toBe(true);
  });

  it("exclude beats keywords", () => {
    const r = rule({ keywords: ["로봇"], exclude: ["청소"] });
    expect(ruleAppliesToText(r, "로봇 청소기 출시")).toBe(false);
    expect(ruleAppliesToText(r, "산업용 로봇 팔")).toBe(true);
  });

  it("empty keywords never match", () => {
    expect(ruleAppliesToText(rule({}), "아무 텍스트")).toBe(false);
  });
});
