import type { Me } from "@myportal/api-contracts";
import { getDb } from "../../config/db";
import { AppError, errorCodes } from "../../errors/error-codes";

export async function getMe(userId: string): Promise<Me> {
  const db = getDb();
  const { rows } = await db.query<{
    id: string;
    email: string;
    timezone: string;
    digest_enabled: boolean;
    digest_frequency: "daily" | "weekly";
    digest_time: string;
    digest_weekday: number;
    digest_categories: unknown;
    digest_limit: number;
    last_visit_at: string | null;
  }>(
    `select u.id, u.email, s.timezone, s.digest_enabled, s.digest_frequency,
            s.digest_time, s.digest_weekday, s.digest_categories,
            s.digest_limit, s.last_visit_at
     from myportal.users u
     left join myportal.user_settings s on s.user_id = u.id
     where u.id = $1`,
    [userId],
  );
  const r = rows[0];
  if (!r) {
    throw new AppError(errorCodes.UNAUTHORIZED, "사용자를 찾을 수 없습니다.", 401);
  }
  return {
    id: r.id,
    email: r.email,
    settings: {
      timezone: r.timezone ?? "Asia/Seoul",
      digestEnabled: r.digest_enabled ?? true,
      digestFrequency: r.digest_frequency ?? "daily",
      digestTime: r.digest_time ?? "07:30",
      digestWeekday: r.digest_weekday ?? 5,
      digestCategories: Array.isArray(r.digest_categories)
        ? r.digest_categories.map(String)
        : typeof r.digest_categories === "string"
          ? (JSON.parse(r.digest_categories) as unknown[]).map(String)
          : [],
      digestLimit: r.digest_limit ?? 10,
      lastVisitAt: r.last_visit_at
        ? new Date(r.last_visit_at).toISOString()
        : null,
    },
  };
}
