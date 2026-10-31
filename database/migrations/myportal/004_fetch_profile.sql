-- 수집 프로파일("어떻게 가져오는가")을 스펙("가져온 것에서 무엇을 뽑는가")과 분리해 보관한다.
-- crawl_specs.spec 안에 두면 자가복구가 스펙을 새 버전으로 교체할 때 렌더링 필요 여부와
-- 측정한 대기 시간이 함께 사라져, 렌더링이 필요한 소스가 정적 HTML을 받아 영구히 0건이 된다.
-- 빈 객체({})는 "아직 측정하지 않음"이며, 읽는 쪽이 기존 spec.render로 폴백한다.
alter table myportal.sources
    add column if not exists fetch_profile jsonb not null default '{}'::jsonb;
