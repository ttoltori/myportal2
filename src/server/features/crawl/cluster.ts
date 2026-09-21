import { getDb } from "../../config/db";

// 제목 유사도로 같은 이야기를 묶는다 (요건정의서 §6 스토리 클러스터).
// pg_trgm similarity로 최근 3일간의 기존 항목과 비교한다.
const SIMILARITY_THRESHOLD = 0.55;
const LOOKBACK_DAYS = 3;

export async function clusterItems(itemIds: string[]): Promise<void> {
  if (itemIds.length === 0) return;
  const db = getDb();

  for (const itemId of itemIds) {
    const { rows: it } = await db.query<{ title: string }>(
      `select title from myportal.items where id = $1`,
      [itemId],
    );
    if (!it[0]) continue;

    const { rows: similar } = await db.query<{
      id: string;
      cluster_id: string | null;
      sim: number;
    }>(
      `select id, cluster_id, similarity(title, $1) as sim
       from myportal.items
       where id <> $2
         and collected_at > now() - interval '${LOOKBACK_DAYS} days'
         and similarity(title, $1) > ${SIMILARITY_THRESHOLD}
       order by sim desc
       limit 1`,
      [it[0].title, itemId],
    );

    const match = similar[0];
    if (!match) continue;

    if (match.cluster_id) {
      await db.query(
        `update myportal.items set cluster_id = $1 where id = $2`,
        [match.cluster_id, itemId],
      );
    } else {
      const { rows: cluster } = await db.query<{ id: string }>(
        `insert into myportal.story_clusters (representative_item_id)
         values ($1) returning id`,
        [match.id],
      );
      const clusterId = cluster[0].id;
      await db.query(
        `update myportal.items set cluster_id = $1 where id = any($2::uuid[])`,
        [clusterId, [match.id, itemId]],
      );
    }
  }
}
