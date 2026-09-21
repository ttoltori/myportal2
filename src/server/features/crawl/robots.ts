import { env } from "../../config/env";

// robots.txt는 도메인당 1시간 캐시한다 (요건정의서 §8).
interface RobotsRule {
  disallow: string[];
  allow: string[];
}
interface CacheEntry {
  rules: RobotsRule | null; // null = robots 없음 → 전체 허용
  fetchedAt: number;
}
const cache = new Map<string, CacheEntry>();
const TTL_MS = 60 * 60 * 1000;

function parseRobots(text: string, ua: string): RobotsRule {
  const groups: { agents: string[]; rules: RobotsRule }[] = [];
  let agents: string[] = [];
  let rules: RobotsRule = { disallow: [], allow: [] };
  let sawRule = false;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) {
      if (agents.length && sawRule) {
        groups.push({ agents, rules });
        agents = [];
        rules = { disallow: [], allow: [] };
        sawRule = false;
      }
      continue;
    }
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      if (sawRule) {
        groups.push({ agents, rules });
        agents = [];
        rules = { disallow: [], allow: [] };
        sawRule = false;
      }
      agents.push(value.toLowerCase());
    } else if (key === "disallow" && value) {
      rules.disallow.push(value);
      sawRule = true;
    } else if (key === "allow" && value) {
      rules.allow.push(value);
      sawRule = true;
    }
  }
  if (agents.length) groups.push({ agents, rules });

  const uaLower = ua.toLowerCase();
  const botName = uaLower.split(/[\s/]/)[0];
  const specific = groups.find((g) =>
    g.agents.some((a) => a !== "*" && uaLower.includes(a)),
  );
  const wildcard = groups.find((g) => g.agents.includes("*"));
  const picked = specific ?? wildcard;
  if (!picked) return { disallow: [], allow: [] };
  void botName;
  return picked.rules;
}

function pathAllowed(path: string, rules: RobotsRule): boolean {
  // 가장 긴 매칭 규칙이 이긴다 (RFC 9309)
  let best = "";
  let allowed = true;
  for (const p of rules.disallow) {
    if (path.startsWith(p) && p.length >= best.length) {
      best = p;
      allowed = false;
    }
  }
  for (const p of rules.allow) {
    if (path.startsWith(p) && p.length > best.length) {
      best = p;
      allowed = true;
    }
  }
  return allowed;
}

export async function robotsAllowed(rawUrl: string): Promise<boolean> {
  const url = new URL(rawUrl);
  const origin = url.origin;
  const now = Date.now();
  let entry = cache.get(origin);
  if (!entry || now - entry.fetchedAt > TTL_MS) {
    let rules: RobotsRule | null = null;
    try {
      const res = await fetch(`${origin}/robots.txt`, {
        headers: { "User-Agent": env.crawlUserAgent },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) rules = parseRobots(await res.text(), env.crawlUserAgent);
    } catch {
      rules = null; // robots.txt 조회 실패 시 허용으로 간주
    }
    entry = { rules, fetchedAt: now };
    cache.set(origin, entry);
  }
  if (!entry.rules) return true;
  return pathAllowed(url.pathname + url.search, entry.rules);
}
