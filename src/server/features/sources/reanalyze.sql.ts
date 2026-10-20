// 재분석·재적용 전용 SQL.
// reanalyzeSource와 applySpecForSource는 sourcesSql의 조회·쓰기문(findById,
// subscriptionForSource, fieldsForSource, latestActiveSpec, deactivateSpecs,
// insertSpec, insertField, insertManualAction)을 그대로 재사용한다.
// 여기에는 이 기능에만 필요한 문장을 둔다. 백필 SQL도 이 객체에 추가된다.
export const reanalyzeSql = {
  // 트랜잭션 안에서 읽어 버전 번호 경쟁(동시 적용)을 막는다.
  maxSpecVersion: `
    select coalesce(max(version), 0)::int as v
    from myportal.crawl_specs
    where source_id = $1
  `,
  // 새 스펙이 유효하므로 연속 실패 카운트는 항상 0으로 되돌린다.
  // status는 일시정지(pause)를 풀지 않도록 호출부가 계산해 $3으로 넘긴다.
  //
  // feed_url($4)도 함께 갱신해야 한다. 수집 경로(collector.extractRows)의 rss
  // 분기는 sources.feed_url만 읽으므로, 재분석이 새로 발견한 피드가 spec.feedUrl에만
  // 있으면 feedTarget이 HTML 페이지를 가리켜 looksLikeFeed가 실패하고 영구히 0건이 된다.
  // 기존 값을 null로 지우지 않도록 coalesce를 쓴다(sourcesSql.updateAfterRun과 동일 관례).
  updateSourceAfterApply: `
    update myportal.sources
    set fetch_strategy = $2, status = $3, consecutive_failures = 0,
        feed_url = coalesce($4, feed_url)
    where id = $1
  `,
  // 매칭에 필요한 컬럼만 읽는다. 소스의 항목 전체를 한 번에 메모리 맵으로 만든다.
  itemsForBackfill: `
    select id, normalized_url, dedupe_hash, collected_at
    from myportal.items
    where source_id = $1
  `,
  // 제목이 바뀌면 dedupe_hash도 바뀌므로 함께 갱신해야 다음 정기 수집이 같은 키를 본다.
  // attrs는 병합한다: 새 추출에서 사라진 키도 source_fields가 유지되는 한 데스크가 라벨을
  // 붙여 보여주므로 값을 지우지 않는다. published_at·excerpt는 새 값이 없을 때 기존 값을
  // 지킨다. collected_at과 읽음·별표(item_states)는 건드리지 않는다.
  updateItemFromRow: `
    update myportal.items
    set title = $2, url = $3, normalized_url = $4, dedupe_hash = $5,
        published_at = coalesce($6, published_at),
        excerpt = coalesce($7, excerpt),
        attrs = attrs || $8::jsonb
    where id = $1
  `,
  // 신규 삽입분을 적용자에게만 읽음 처리한다. runBaseline과 같은 방식이다.
  markReadForUser: `
    insert into myportal.item_states (user_id, item_id, read, read_at)
    values ($1, $2, true, now())
    on conflict (user_id, item_id) do nothing
  `,
} as const;
