export const sourcesSql = {
  findByNormalizedUrl: `
    select id, url, kind, fetch_strategy, status
    from myportal.sources
    where normalized_url = $1
  `,
  findById: `
    select id, url, normalized_url, kind, fetch_strategy, status,
           interval_minutes, fixed_interval, next_crawl_at, last_success_at,
           consecutive_failures, etag, last_modified, feed_url, page_title
    from myportal.sources
    where id = $1
  `,
  insertSource: `
    insert into myportal.sources
        (url, normalized_url, kind, fetch_strategy, status, feed_url, page_title, next_crawl_at)
    values ($1, $2, $3, $4, $5, $6, $7, now())
    returning id
  `,
  insertSubscription: `
    insert into myportal.subscriptions (user_id, source_id, display_name, category_id)
    values ($1, $2, $3, $4)
    returning id
  `,
  insertField: `
    insert into myportal.source_fields (source_id, key, label, type, role, sort_order, visible)
    values ($1, $2, $3, $4, $5, $6, $7)
    on conflict (source_id, key) do update
        set label = excluded.label, type = excluded.type, role = excluded.role,
            sort_order = excluded.sort_order, visible = excluded.visible
  `,
  fieldsForSource: `
    select key, label, type, role, sort_order, visible
    from myportal.source_fields
    where source_id = $1
    order by sort_order
  `,
  specVersions: `
    select version, spec, created_by, active, created_at
    from myportal.crawl_specs
    where source_id = $1
    order by version desc
    limit 20
  `,
  latestActiveSpec: `
    select version, spec
    from myportal.crawl_specs
    where source_id = $1 and active = true
    order by version desc
    limit 1
  `,
  insertSpec: `
    insert into myportal.crawl_specs (source_id, version, spec, created_by, active)
    values ($1, $2, $3::jsonb, $4, true)
    returning version
  `,
  deactivateSpecs: `
    update myportal.crawl_specs set active = false where source_id = $1
  `,
  updateAfterRun: `
    update myportal.sources
    set status = $2, last_success_at = $3, consecutive_failures = $4,
        next_crawl_at = $5, etag = coalesce($6, etag),
        last_modified = coalesce($7, last_modified),
        feed_url = coalesce($8, feed_url), interval_minutes = $9
    where id = $1
  `,
  subscriptionForSource: `
    select id, user_id, display_name, category_id, paused
    from myportal.subscriptions
    where source_id = $1 and user_id = $2
  `,
  subscriptionForSourceAnyUser: `
    select id, user_id, display_name, category_id, paused
    from myportal.subscriptions
    where source_id = $1
  `,
  recentRuns: `
    select id, ran_at, strategy, duration_ms, new_count, result
    from myportal.crawl_runs
    where source_id = $1
    order by ran_at desc
    limit 20
  `,
  insertRun: `
    insert into myportal.crawl_runs
        (source_id, strategy, duration_ms, new_count, result, error_code, error_detail)
    values ($1, $2, $3, $4, $5, $6, $7)
    returning id
  `,
  insertItem: `
    insert into myportal.items
        (source_id, title, url, normalized_url, dedupe_hash, published_at,
         collected_at, excerpt, attrs, is_baseline)
    values ($1, $2, $3, $4, $5, $6, now(), $7, $8::jsonb, $9)
    on conflict (source_id, dedupe_hash) do nothing
    returning id
  `,
  itemsForSource: `
    select id, source_id, title, url, published_at, collected_at, excerpt,
           attrs, is_baseline, cluster_id
    from myportal.items
    where source_id = $1
    order by collected_at desc
    limit $2
  `,
  lastManualCollect: `
    select created_at from myportal.manual_actions
    where source_id = $1 and action = 'collect'
    order by created_at desc
    limit 1
  `,
  insertManualAction: `
    insert into myportal.manual_actions (user_id, source_id, action)
    values ($1, $2, $3)
  `,
  dueSources: `
    select s.id, s.url, s.normalized_url, s.fetch_strategy, s.feed_url,
           s.etag, s.last_modified, s.interval_minutes, s.consecutive_failures
    from myportal.sources s
    where s.kind = 'list'
      and s.status <> 'pause'
      and (s.next_crawl_at is null or s.next_crawl_at <= now())
      and exists (
          select 1 from myportal.subscriptions sub
          where sub.source_id = s.id and sub.paused = false
      )
    order by s.next_crawl_at asc nulls first
    limit $1
  `,
};
