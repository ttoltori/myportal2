-- 연속 빈 추출 횟수("접근은 됐는데 아무것도 못 뽑음")를 접근 실패 횟수와 분리해 보관한다.
-- consecutive_failures는 예외로 끝난 수집에서만 증가하고, 예외 없이 0건으로 끝난 수집은
-- 성공으로 처리되어 0으로 리셋된다. 그래서 사이트 개편으로 셀렉터가 아무것도 못 잡는
-- 가장 흔한 상황에서 자가복구 조건(연속 실패 임계)에 영원히 도달하지 못했다.
-- 새 컬럼은 추출 행이 0건일 때만 증가하고 1건 이상이면 0으로 돌아간다.
-- "새 항목 없음"(기존 항목은 추출됨)은 정상이므로 세지 않는다.
alter table myportal.sources
    add column if not exists consecutive_empty integer not null default 0;

comment on column myportal.sources.consecutive_empty is
    '연속 빈 추출 횟수 — 추출 행이 0건이면 +1, 1건 이상이면 0. 임계 도달 시 스펙 self-repair 트리거 (접근 실패 횟수는 consecutive_failures)';

-- 002_comments가 consecutive_failures에 붙인 "self-repair 트리거" 코멘트는 이제 사실이 아니다.
-- 트리거는 consecutive_empty로 옮겨졌다. 002는 적용된 파일이라 수정할 수 없으므로 여기서 갱신한다.
comment on column myportal.sources.consecutive_failures is
    '연속 접근 실패 횟수 — 수집이 예외로 끝나면 +1, 예외 없이 끝나면 0. status 판정(warn/fail)에 쓰이며 self-repair 트리거가 아님 (트리거는 consecutive_empty)';
