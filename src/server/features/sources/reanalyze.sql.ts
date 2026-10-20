// 재분석·재적용 전용 SQL.
// reanalyzeSource는 sourcesSql의 조회문(findById, subscriptionForSource,
// fieldsForSource, latestActiveSpec)을 그대로 재사용하므로 아직 상수가 없다.
// 적용(apply-spec)과 백필 SQL이 이 객체에 추가된다.
export const reanalyzeSql = {} as const;
