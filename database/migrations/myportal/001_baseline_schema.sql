-- myportal baseline schema (요건정의서 §7 개념 모델)
-- 공유 영역(크롤링 결과)과 사용자 영역(구독·읽음 상태)을 분리한다.

create schema if not exists myportal;

-- 이야기 묶음(제목 유사도)과 검색에 pg_trgm 사용
create extension if not exists pg_trgm;
create extension if not exists pgcrypto;

-- ── 공유 영역 ─────────────────────────────────────────

create table if not exists myportal.sources (
    id                   uuid primary key default gen_random_uuid(),
    url                  text not null,
    normalized_url       text not null unique,
    kind                 text not null default 'list' check (kind in ('list', 'link')),
    fetch_strategy       text not null default 'html'
                         check (fetch_strategy in ('rss', 'structured', 'html', 'rendered', 'link')),
    status               text not null default 'ok'
                         check (status in ('ok', 'warn', 'fail', 'pause', 'link')),
    interval_minutes     integer not null default 60,
    fixed_interval       boolean not null default false,
    next_crawl_at        timestamptz,
    last_success_at      timestamptz,
    consecutive_failures integer not null default 0,
    etag                 text,
    last_modified        text,
    feed_url             text,
    page_title           text,
    created_at           timestamptz not null default now()
);

create table if not exists myportal.source_fields (
    id          uuid primary key default gen_random_uuid(),
    source_id   uuid not null references myportal.sources(id) on delete cascade,
    key         text not null,
    label       text not null,
    type        text not null default 'text'
                check (type in ('text', 'url', 'date', 'datetime', 'date_range', 'number', 'image', 'tag_list')),
    role        text not null default 'none'
                check (role in ('title', 'link', 'published', 'deadline', 'summary', 'none')),
    sort_order  integer not null default 0,
    visible     boolean not null default true,
    unique (source_id, key)
);

create table if not exists myportal.crawl_specs (
    id          uuid primary key default gen_random_uuid(),
    source_id   uuid not null references myportal.sources(id) on delete cascade,
    version     integer not null,
    spec        jsonb not null,
    created_by  text not null default 'heuristic',
    active      boolean not null default true,
    created_at  timestamptz not null default now(),
    unique (source_id, version)
);

create table if not exists myportal.crawl_runs (
    id           uuid primary key default gen_random_uuid(),
    source_id    uuid not null references myportal.sources(id) on delete cascade,
    ran_at       timestamptz not null default now(),
    strategy     text not null,
    duration_ms  integer not null default 0,
    new_count    integer not null default 0,
    result       text not null default 'ok' check (result in ('ok', 'error', 'unchanged')),
    error_code   text,
    error_detail text
);
create index if not exists crawl_runs_source_idx on myportal.crawl_runs (source_id, ran_at desc);

create table if not exists myportal.crawl_jobs (
    id         uuid primary key default gen_random_uuid(),
    source_id  uuid not null references myportal.sources(id) on delete cascade,
    run_after  timestamptz not null default now(),
    locked_at  timestamptz,
    locked_by  text,
    attempts   integer not null default 0,
    done_at    timestamptz,
    created_at timestamptz not null default now()
);
create index if not exists crawl_jobs_pending_idx
    on myportal.crawl_jobs (run_after) where done_at is null;

create table if not exists myportal.story_clusters (
    id                    uuid primary key default gen_random_uuid(),
    representative_item_id uuid,
    created_at            timestamptz not null default now()
);

create table if not exists myportal.items (
    id             uuid primary key default gen_random_uuid(),
    source_id      uuid not null references myportal.sources(id) on delete cascade,
    title          text not null,
    url            text,
    normalized_url text,
    dedupe_hash    text not null,
    published_at   timestamptz,
    collected_at   timestamptz not null default now(),
    excerpt        text,
    attrs          jsonb not null default '{}'::jsonb,
    is_baseline    boolean not null default false,
    cluster_id     uuid references myportal.story_clusters(id) on delete set null,
    unique (source_id, dedupe_hash)
);
create index if not exists items_source_collected_idx on myportal.items (source_id, collected_at desc);
create index if not exists items_collected_idx on myportal.items (collected_at desc);
create index if not exists items_title_trgm_idx on myportal.items using gin (title gin_trgm_ops);
create index if not exists items_cluster_idx on myportal.items (cluster_id) where cluster_id is not null;

alter table myportal.story_clusters
    add constraint story_clusters_rep_fk
    foreign key (representative_item_id) references myportal.items(id) on delete set null;

-- ── 사용자 영역 ───────────────────────────────────────

create table if not exists myportal.users (
    id         uuid primary key default gen_random_uuid(),
    email      text not null unique,
    created_at timestamptz not null default now()
);

create table if not exists myportal.user_settings (
    user_id            uuid primary key references myportal.users(id) on delete cascade,
    timezone           text not null default 'Asia/Seoul',
    digest_enabled     boolean not null default true,
    digest_frequency   text not null default 'daily' check (digest_frequency in ('daily', 'weekly')),
    digest_time        text not null default '07:30',
    digest_weekday     integer not null default 5 check (digest_weekday between 0 and 6),
    digest_categories  jsonb not null default '[]'::jsonb,
    digest_limit       integer not null default 10,
    digest_sent_at     timestamptz,
    last_visit_at      timestamptz,
    last_seen_at       timestamptz
);

create table if not exists myportal.magic_links (
    id         uuid primary key default gen_random_uuid(),
    email      text not null,
    token_hash text not null unique,
    expires_at timestamptz not null,
    used_at    timestamptz,
    created_at timestamptz not null default now()
);

create table if not exists myportal.sessions (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid not null references myportal.users(id) on delete cascade,
    token_hash text not null unique,
    expires_at timestamptz not null,
    created_at timestamptz not null default now()
);
create index if not exists sessions_user_idx on myportal.sessions (user_id);

create table if not exists myportal.categories (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid not null references myportal.users(id) on delete cascade,
    name       text not null,
    parent_id  uuid references myportal.categories(id) on delete cascade,
    sort_order integer not null default 0,
    created_at timestamptz not null default now()
);
create index if not exists categories_user_idx on myportal.categories (user_id, parent_id);

create table if not exists myportal.tags (
    id      uuid primary key default gen_random_uuid(),
    user_id uuid not null references myportal.users(id) on delete cascade,
    name    text not null,
    unique (user_id, name)
);

create table if not exists myportal.subscriptions (
    id           uuid primary key default gen_random_uuid(),
    user_id      uuid not null references myportal.users(id) on delete cascade,
    source_id    uuid not null references myportal.sources(id) on delete cascade,
    display_name text not null,
    category_id  uuid references myportal.categories(id) on delete set null,
    paused       boolean not null default false,
    created_at   timestamptz not null default now(),
    unique (user_id, source_id)
);
create index if not exists subscriptions_user_idx on myportal.subscriptions (user_id, category_id);
create index if not exists subscriptions_source_idx on myportal.subscriptions (source_id);

create table if not exists myportal.subscription_tags (
    subscription_id uuid not null references myportal.subscriptions(id) on delete cascade,
    tag_id          uuid not null references myportal.tags(id) on delete cascade,
    primary key (subscription_id, tag_id)
);

create table if not exists myportal.item_states (
    user_id  uuid not null references myportal.users(id) on delete cascade,
    item_id  uuid not null references myportal.items(id) on delete cascade,
    read     boolean not null default false,
    read_at  timestamptz,
    starred  boolean not null default false,
    primary key (user_id, item_id)
);
create index if not exists item_states_user_read_idx on myportal.item_states (user_id, read);

create table if not exists myportal.keyword_rules (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid not null references myportal.users(id) on delete cascade,
    name       text not null,
    keywords   jsonb not null default '[]'::jsonb,
    exclude    jsonb not null default '[]'::jsonb,
    scope      text not null default 'all' check (scope in ('all', 'category', 'tag')),
    scope_id   uuid,
    action     text not null check (action in ('emphasize', 'alert', 'mute')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- 규칙 매칭 결과: 사용자·항목당 우선순위가 가장 높은 규칙 1건만 저장한다.
create table if not exists myportal.item_rule_matches (
    user_id uuid not null references myportal.users(id) on delete cascade,
    item_id uuid not null references myportal.items(id) on delete cascade,
    rule_id uuid not null references myportal.keyword_rules(id) on delete cascade,
    action  text not null check (action in ('emphasize', 'alert', 'mute')),
    primary key (user_id, item_id)
);
create index if not exists item_rule_matches_user_idx on myportal.item_rule_matches (user_id, action);

create table if not exists myportal.digest_runs (
    id           uuid primary key default gen_random_uuid(),
    user_id      uuid not null references myportal.users(id) on delete cascade,
    ran_at       timestamptz not null default now(),
    item_count   integer not null default 0,
    result       text not null check (result in ('ok', 'fail', 'skipped', 'queued')),
    error_detail text,
    content_html text
);
create index if not exists digest_runs_user_idx on myportal.digest_runs (user_id, ran_at desc);

-- 수동 "지금 수집" 호출 간격 제한용 (소스당 최소 간격)
create table if not exists myportal.manual_actions (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid not null references myportal.users(id) on delete cascade,
    source_id  uuid references myportal.sources(id) on delete cascade,
    action     text not null,
    created_at timestamptz not null default now()
);
create index if not exists manual_actions_idx on myportal.manual_actions (source_id, action, created_at desc);
