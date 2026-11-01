-- robots.txt 금지를 사용자가 명시적으로 무시하도록 선택한 소스를 표시한다.
-- 분석 단계에만 두지 않고 소스에 보관하는 이유: 수집(collectSource)도 robots를 검사해
-- 금지면 소스를 pause시키므로, 분석만 무시하게 하면 등록 직후 첫 수집에서 멈춰
-- 옵션이 아무 일도 하지 못한다. "분석에서 무시했다"는 선택은 수집까지 이어져야 뜻이 있다.
-- 기본값 false — 준수가 기본이고, 무시는 사용자가 소스마다 켜는 예외다(요건 CRAWL-07).
alter table myportal.sources
    add column if not exists ignore_robots boolean not null default false;

comment on column myportal.sources.ignore_robots is
    'robots.txt 금지를 무시할지 — 사용자가 등록·재분석 화면에서 명시적으로 켠 소스만 true. 분석과 정기 수집 양쪽의 robots 검사를 건너뛴다';
