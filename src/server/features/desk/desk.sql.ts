export const deskSql = {
  categories: `
    select id, name, parent_id, sort_order
    from myportal.categories
    where user_id = $1
    order by sort_order, name
  `,
  tags: `
    select id, name
    from myportal.tags
    where user_id = $1
    order by name
  `,
  subscriptions: `
    select s.id, s.source_id, s.display_name, s.category_id, s.paused,
           src.url, src.fetch_strategy, src.status, src.last_success_at,
           src.interval_minutes
    from myportal.subscriptions s
    join myportal.sources src on src.id = s.source_id
    where s.user_id = $1
    order by s.display_name
  `,
  subscriptionTags: `
    select st.subscription_id, st.tag_id
    from myportal.subscription_tags st
    join myportal.subscriptions s on s.id = st.subscription_id
    where s.user_id = $1
  `,
  newCounts7d: `
    select i.source_id, count(*)::int as c
    from myportal.items i
    where i.is_baseline = false
      and i.collected_at > now() - interval '7 days'
      and i.source_id in (
        select source_id from myportal.subscriptions
        where user_id = $1 and paused = false
      )
    group by i.source_id
  `,
  keywordRules: `
    select id, name, keywords, exclude, scope, scope_id, action
    from myportal.keyword_rules
    where user_id = $1
    order by created_at
  `,
  // mute 규칙에 걸린 항목은 데스크에서 숨긴다.
  items: `
    select i.id, i.source_id, i.title, i.url, i.published_at, i.collected_at,
           i.excerpt, i.attrs, i.is_baseline, i.cluster_id,
           coalesce(st.read, false) as read,
           coalesce(st.starred, false) as starred,
           rm.rule_id, rm.action as rule_action, kr.name as rule_name
    from myportal.items i
    join myportal.subscriptions s
      on s.source_id = i.source_id and s.user_id = $1 and s.paused = false
    left join myportal.item_states st
      on st.item_id = i.id and st.user_id = $1
    left join myportal.item_rule_matches rm
      on rm.item_id = i.id and rm.user_id = $1
    left join myportal.keyword_rules kr on kr.id = rm.rule_id
    where i.is_baseline = false
      and coalesce(rm.action, '') <> 'mute'
    order by i.collected_at desc
    limit $2
  `,
  clusters: `
    select c.id, c.representative_item_id
    from myportal.story_clusters c
    where c.id in (
      select distinct i.cluster_id
      from myportal.items i
      join myportal.subscriptions s
        on s.source_id = i.source_id and s.user_id = $1
      where i.cluster_id is not null
    )
  `,
  settings: `
    select last_visit_at, last_seen_at
    from myportal.user_settings
    where user_id = $1
  `,
  touchSeen: `
    update myportal.user_settings set last_seen_at = now() where user_id = $1
  `,
  heartbeat: `
    update myportal.user_settings
    set last_visit_at = coalesce(last_seen_at, now()), last_seen_at = now()
    where user_id = $1
    returning last_visit_at
  `,
  lastCollect: `
    select max(r.ran_at) as last_run
    from myportal.crawl_runs r
    join myportal.subscriptions s on s.source_id = r.source_id
    where s.user_id = $1
  `,
  warnCount: `
    select count(*)::int as c
    from myportal.subscriptions s
    join myportal.sources src on src.id = s.source_id
    where s.user_id = $1 and src.status in ('warn', 'fail')
  `,
  userEmail: `
    select email from myportal.users where id = $1
  `,
  deadlineFields: `
    select source_id, key
    from myportal.source_fields
    where role = 'deadline' and visible = true
  `,
};
