-- LLM 호출 이력. 일별 상한 판정(NFR-L4)과 비용 추적에 사용한다.
create table if not exists myportal.llm_calls (
    id                uuid primary key default gen_random_uuid(),
    -- 시스템 경로(수집 자가복구)는 null. 사용자 삭제 시 이력은 남긴다.
    user_id           uuid references myportal.users(id) on delete set null,
    source_id         uuid references myportal.sources(id) on delete set null,
    -- analyze-fields | analyze-rescue | rebuild | self-repair
    purpose           text not null,
    model             text not null,
    prompt_tokens     integer,
    completion_tokens integer,
    duration_ms       integer,
    ok                boolean not null,
    error_code        text,
    created_at        timestamptz not null default now()
);

-- 일별 상한 판정 쿼리(user_id + created_at 범위)용
create index if not exists llm_calls_user_created_idx
    on myportal.llm_calls (user_id, created_at desc);
create index if not exists llm_calls_created_idx
    on myportal.llm_calls (created_at desc);
