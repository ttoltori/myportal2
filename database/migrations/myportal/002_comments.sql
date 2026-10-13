-- 002_comments: 테이블·컬럼 문서화
-- 모든 테이블과 컬럼에 COMMENT를 부여한다.
-- 확인: psql \d+ myportal.sources 또는 Supabase Table Editor의 컬럼 설명.

comment on schema myportal is 'myportal 서비스 전용 스키마';

comment on table myportal.schema_migrations is '적용된 마이그레이션 파일 기록 (migrate.ts가 관리)';
comment on column myportal.schema_migrations.name is '마이그레이션 파일명';
comment on column myportal.schema_migrations.applied_at is '적용 시각';

-- ── 공유 영역 ─────────────────────────────────────────

comment on table myportal.sources is
    '수집 대상 소스(목록 페이지 URL). 공유 영역 — 같은 소스를 여러 사용자가 구독할 수 있다';
comment on column myportal.sources.id is '기본 키 (UUID, 자동 생성)';
comment on column myportal.sources.url is '사용자가 등록한 원본 URL';
comment on column myportal.sources.normalized_url is '중복 검사용 정규화 URL (트래킹 파라미터 제거·호스트 소문자·쿼리 정렬)';
comment on column myportal.sources.kind is '소스 유형: list=수집 대상, link=링크 전용(수집 안 함)';
comment on column myportal.sources.fetch_strategy is '추출 전략: rss / structured(JSON-LD) / html(DOM 스펙) / rendered / link';
comment on column myportal.sources.status is '소스 상태: ok / warn(1~2회 실패) / fail(3회 이상 실패) / pause / link';
comment on column myportal.sources.interval_minutes is '수집 주기(분). 적응형 — 신규 없으면 2배 증가(최대 24h), 신규 있으면 15분';
comment on column myportal.sources.fixed_interval is 'true면 사용자 지정 고정 주기 (적응형 조정 비활성)';
comment on column myportal.sources.next_crawl_at is '다음 수집 예정 시각 — crawl-tick의 due 판정 기준';
comment on column myportal.sources.last_success_at is '마지막 성공 수집 시각';
comment on column myportal.sources.consecutive_failures is '연속 실패 횟수 — 임계 도달 시 스펙 self-repair 트리거';
comment on column myportal.sources.etag is 'HTTP 조건부 요청용 ETag (If-None-Match)';
comment on column myportal.sources.last_modified is 'HTTP 조건부 요청용 Last-Modified (If-Modified-Since)';
comment on column myportal.sources.feed_url is 'RSS 전략일 때 발견된 피드 URL';
comment on column myportal.sources.page_title is '분석 시 추출한 페이지 제목 (구독 표시명 제안용)';
comment on column myportal.sources.created_at is '등록 시각';

comment on table myportal.source_fields is
    '소스별 항목 필드 정의 — title/link/published 외에 추출된 커스텀 속성의 표시 메타데이터';
comment on column myportal.source_fields.id is '기본 키 (UUID, 자동 생성)';
comment on column myportal.source_fields.source_id is '소속 소스 — sources.id 참조';
comment on column myportal.source_fields.key is '필드 키 (items.attrs의 키와 대응)';
comment on column myportal.source_fields.label is '화면 표시 라벨';
comment on column myportal.source_fields.type is '값 유형: text / url / date / datetime / date_range / number / image / tag_list';
comment on column myportal.source_fields.role is '필드 역할: title / link / published / deadline(마감일) / summary / none';
comment on column myportal.source_fields.sort_order is '컬럼 표시 순서';
comment on column myportal.source_fields.visible is '목록 화면 표시 여부';

comment on table myportal.crawl_specs is
    '소스별 추출 스펙 버전. 활성(active) 버전이 수집에 사용되고, self-repair/재생성 시 새 버전이 추가된다';
comment on column myportal.crawl_specs.id is '기본 키 (UUID, 자동 생성)';
comment on column myportal.crawl_specs.source_id is '소속 소스 — sources.id 참조';
comment on column myportal.crawl_specs.version is '소스 내 스펙 버전 번호 (1부터 증가)';
comment on column myportal.crawl_specs.spec is '추출 스펙 JSON: {strategy, feedUrl?, itemSelector?, fields{key:{selector,attr?}}, hint?}';
comment on column myportal.crawl_specs.created_by is '생성 경로: heuristic(자동) / manual(수동 재생성) / self-repair(자동 복구)';
comment on column myportal.crawl_specs.active is '활성 버전 여부 — 소스당 1개만 true';
comment on column myportal.crawl_specs.created_at is '버전 생성 시각';

comment on table myportal.crawl_runs is '수집 실행 이력 — 주기 수집과 수동 수집 모두 기록';
comment on column myportal.crawl_runs.id is '기본 키 (UUID, 자동 생성)';
comment on column myportal.crawl_runs.source_id is '수집 대상 소스 — sources.id 참조';
comment on column myportal.crawl_runs.ran_at is '수집 실행 시각';
comment on column myportal.crawl_runs.strategy is '실행에 사용된 추출 전략';
comment on column myportal.crawl_runs.duration_ms is '실행 소요 시간(밀리초)';
comment on column myportal.crawl_runs.new_count is '신규 저장된 항목 수 (중복 제외)';
comment on column myportal.crawl_runs.result is '결과: ok / error / unchanged(304 등 변경 없음)';
comment on column myportal.crawl_runs.error_code is '실패 시 오류 코드 (errorCodes 참조)';
comment on column myportal.crawl_runs.error_detail is '실패 시 상세 메시지 (최대 500자, 내부용)';

comment on table myportal.crawl_jobs is '수집 작업 큐 — 수동 "지금 수집" 요청 등을 비동기로 처리';
comment on column myportal.crawl_jobs.id is '기본 키 (UUID, 자동 생성)';
comment on column myportal.crawl_jobs.source_id is '수집 대상 소스 — sources.id 참조';
comment on column myportal.crawl_jobs.created_at is '큐 등록 시각';
comment on column myportal.crawl_jobs.run_after is '실행 가능 시작 시각';
comment on column myportal.crawl_jobs.locked_at is '워커가 잡은 시각 (중복 실행 방지 잠금)';
comment on column myportal.crawl_jobs.locked_by is '잠금을 획득한 워커 식별자';
comment on column myportal.crawl_jobs.attempts is '실행 시도 횟수';
comment on column myportal.crawl_jobs.done_at is '완료 시각 (null이면 대기 중)';

comment on table myportal.story_clusters is '제목 유사도(pg_trgm)로 묶인 같은 이야기의 항목 그룹';
comment on column myportal.story_clusters.id is '기본 키 (UUID, 자동 생성)';
comment on column myportal.story_clusters.representative_item_id is '클러스터 대표 항목 ID (목록에 표시되는 항목)';
comment on column myportal.story_clusters.created_at is '클러스터 생성 시각';

comment on table myportal.items is
    '수집된 항목(기사/공고 등). 공유 영역 — 읽음/별표 같은 사용자별 상태는 item_states에 분리';
comment on column myportal.items.id is '기본 키 (UUID, 자동 생성)';
comment on column myportal.items.source_id is '수집 출처 소스 — sources.id 참조';
comment on column myportal.items.title is '항목 제목';
comment on column myportal.items.url is '항목 원본 링크';
comment on column myportal.items.normalized_url is '정규화된 항목 링크';
comment on column myportal.items.dedupe_hash is '중복 제거 해시: sha256(normalized_url + title 정규화) 앞 32자 (소스당 unique)';
comment on column myportal.items.published_at is '원문 게시일 (추출 가능한 경우)';
comment on column myportal.items.collected_at is '수집 시각 — "이전 방문 이후 신규" 판정 기준';
comment on column myportal.items.excerpt is '본문 요약/발췌';
comment on column myportal.items.attrs is '소스별 추가 속성 JSON — source_fields.key에 대응 (주최사, 마감일, 조회수 등)';
comment on column myportal.items.is_baseline is '기준선 항목 여부 — 소스 등록 시점의 기존 항목으로 신규로 간주하지 않음';
comment on column myportal.items.cluster_id is '이야기 클러스터 ID (null이면 클러스터 없음)';

-- ── 사용자 영역 ───────────────────────────────────────

comment on table myportal.users is '사용자 — 매직링크 로그인 시 자동 생성';
comment on column myportal.users.id is '기본 키 (UUID, 자동 생성)';
comment on column myportal.users.email is '로그인 이메일 (ALLOWED_EMAILS 설정 시 목록 내 이메일만 허용)';
comment on column myportal.users.created_at is '가입 시각';

comment on table myportal.user_settings is '사용자별 설정 — 다이제스트, 타임존, 방문 시각 등';
comment on column myportal.user_settings.user_id is '대상 사용자 — users.id 참조 (기본 키 겸용)';
comment on column myportal.user_settings.timezone is 'IANA 타임존 (다이제스트 발송 시각 계산용)';
comment on column myportal.user_settings.digest_enabled is '다이제스트 발송 여부';
comment on column myportal.user_settings.digest_frequency is '발송 주기: daily / weekly';
comment on column myportal.user_settings.digest_time is '발송 시각 (HH24:MI, 사용자 타임존 기준)';
comment on column myportal.user_settings.digest_weekday is '주간 발송 요일 (0=일요일~6=토요일)';
comment on column myportal.user_settings.digest_categories is '다이제스트에 포함할 카테고리 ID 배열 (빈 배열=전체)';
comment on column myportal.user_settings.digest_limit is '다이제스트당 최대 항목 수';
comment on column myportal.user_settings.digest_sent_at is '마지막 다이제스트 발송 시각 (20시간 재발송 방지)';
comment on column myportal.user_settings.last_visit_at is '마지막 방문 시각 — 신규 항목 판정 기준';
comment on column myportal.user_settings.last_seen_at is '마지막 활동 시각 (heartbeat)';

comment on table myportal.magic_links is '로그인 매직링크 토큰 — 해시만 저장, 1회용';
comment on column myportal.magic_links.id is '기본 키 (UUID, 자동 생성)';
comment on column myportal.magic_links.created_at is '토큰 발급 시각';
comment on column myportal.magic_links.email is '링크를 요청한 이메일';
comment on column myportal.magic_links.token_hash is '토큰의 sha256 해시 — 원본 토큰은 저장하지 않는다';
comment on column myportal.magic_links.expires_at is '만료 시각';
comment on column myportal.magic_links.used_at is '사용 시각 (null이면 미사용)';

comment on table myportal.sessions is '로그인 세션 — 토큰 해시만 저장';
comment on column myportal.sessions.id is '기본 키 (UUID, 자동 생성)';
comment on column myportal.sessions.user_id is '세션 소유 사용자 — users.id 참조';
comment on column myportal.sessions.created_at is '세션 생성 시각';
comment on column myportal.sessions.token_hash is '세션 토큰의 sha256 해시 — 원본은 쿠키에만 존재';
comment on column myportal.sessions.expires_at is '세션 만료 시각 (기본 30일)';

comment on table myportal.categories is '사용자별 카테고리 (계층 구조)';
comment on column myportal.categories.id is '기본 키 (UUID, 자동 생성)';
comment on column myportal.categories.user_id is '소유 사용자 — users.id 참조';
comment on column myportal.categories.created_at is '생성 시각';
comment on column myportal.categories.name is '카테고리 이름';
comment on column myportal.categories.parent_id is '부모 카테고리 ID (null=루트)';
comment on column myportal.categories.sort_order is '같은 부모 내 표시 순서';

comment on table myportal.tags is '사용자별 태그';
comment on column myportal.tags.id is '기본 키 (UUID, 자동 생성)';
comment on column myportal.tags.user_id is '소유 사용자 — users.id 참조';
comment on column myportal.tags.name is '태그 이름 (사용자 내 unique)';

comment on table myportal.subscriptions is
    '사용자의 소스 구독 — 소스(공유)와 사용자별 표시명/분류/일시정지를 연결';
comment on column myportal.subscriptions.id is '기본 키 (UUID, 자동 생성)';
comment on column myportal.subscriptions.user_id is '구독 사용자 — users.id 참조';
comment on column myportal.subscriptions.source_id is '구독 대상 소스 — sources.id 참조';
comment on column myportal.subscriptions.created_at is '구독 시각';
comment on column myportal.subscriptions.display_name is '사용자가 지정한 소스 표시명';
comment on column myportal.subscriptions.category_id is '소속 카테고리 (null=미분류, 카테고리 삭제 시 null로 해제)';
comment on column myportal.subscriptions.paused is '일시정지 여부 — 목록 표시 중지 (수집 자체는 공유 소스라 계속됨)';

comment on table myportal.subscription_tags is '구독-태그 매핑 (다대다)';
comment on column myportal.subscription_tags.subscription_id is '구독 — subscriptions.id 참조';
comment on column myportal.subscription_tags.tag_id is '태그 — tags.id 참조';

comment on table myportal.item_states is '사용자별 항목 상태 — 읽음/별표. 상태가 없는 행은 미읽음으로 간주';
comment on column myportal.item_states.user_id is '사용자 — users.id 참조';
comment on column myportal.item_states.item_id is '항목 — items.id 참조';
comment on column myportal.item_states.read is '읽음 여부';
comment on column myportal.item_states.read_at is '읽은 시각';
comment on column myportal.item_states.starred is '별표 여부';

comment on table myportal.keyword_rules is '사용자별 키워드 규칙 — 매칭된 항목을 강조/알림/숨김 처리';
comment on column myportal.keyword_rules.id is '기본 키 (UUID, 자동 생성)';
comment on column myportal.keyword_rules.user_id is '소유 사용자 — users.id 참조';
comment on column myportal.keyword_rules.created_at is '생성 시각';
comment on column myportal.keyword_rules.name is '규칙 이름';
comment on column myportal.keyword_rules.keywords is '포함 키워드 배열 (JSON, 하나라도 매칭되면 적용)';
comment on column myportal.keyword_rules.exclude is '제외 키워드 배열 (JSON, 매칭되면 규칙 무효)';
comment on column myportal.keyword_rules.scope is '적용 범위: all(전체) / category / tag';
comment on column myportal.keyword_rules.scope_id is '범위 대상 ID — category면 categories.id, tag면 tags.id';
comment on column myportal.keyword_rules.action is '동작: emphasize(강조) / alert(알림) / mute(숨김)';
comment on column myportal.keyword_rules.updated_at is '마지막 수정 시각';

comment on table myportal.item_rule_matches is
    '규칙 매칭 결과 — 사용자·항목당 우선순위가 가장 높은 규칙 1건만 저장';
comment on column myportal.item_rule_matches.user_id is '사용자 — users.id 참조';
comment on column myportal.item_rule_matches.item_id is '매칭된 항목 — items.id 참조';
comment on column myportal.item_rule_matches.rule_id is '적용된 규칙 ID';
comment on column myportal.item_rule_matches.action is '적용된 동작 (규칙 삭제/변경 시 정합성 유지용 복사본)';

comment on table myportal.digest_runs is '다이제스트 생성/발송 이력';
comment on column myportal.digest_runs.id is '기본 키 (UUID, 자동 생성)';
comment on column myportal.digest_runs.user_id is '발송 대상 사용자 — users.id 참조';
comment on column myportal.digest_runs.ran_at is '발송/생성 시각';
comment on column myportal.digest_runs.item_count is '다이제스트에 포함된 항목 수';
comment on column myportal.digest_runs.result is '결과: ok(발송) / fail / skipped(항목 없음 등) / queued(SMTP 미설정)';
comment on column myportal.digest_runs.error_detail is '실패 시 상세 메시지 (내부용)';
comment on column myportal.digest_runs.content_html is '생성된 다이제스트 HTML (미리보기/재발송용)';

comment on table myportal.manual_actions is
    '수동 액션 이력 — "지금 수집" 등의 최소 간격(쿨다운) 판정용';
comment on column myportal.manual_actions.id is '기본 키 (UUID, 자동 생성)';
comment on column myportal.manual_actions.user_id is '액션을 요청한 사용자 — users.id 참조';
comment on column myportal.manual_actions.source_id is '대상 소스 (null이면 소스 무관 액션)';
comment on column myportal.manual_actions.action is '액션 종류 (예: collect-now)';
comment on column myportal.manual_actions.created_at is '액션 실행 시각';
