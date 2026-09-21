export const authSql = {
  insertMagicLink: `
    insert into myportal.magic_links (email, token_hash, expires_at)
    values ($1, $2, $3)
    returning id
  `,
  findMagicLink: `
    select id, email, expires_at, used_at
    from myportal.magic_links
    where token_hash = $1
  `,
  markMagicLinkUsed: `
    update myportal.magic_links
    set used_at = now()
    where id = $1 and used_at is null
  `,
  upsertUser: `
    insert into myportal.users (email)
    values ($1)
    on conflict (email) do update set email = excluded.email
    returning id, email, created_at
  `,
  ensureUserSettings: `
    insert into myportal.user_settings (user_id)
    values ($1)
    on conflict (user_id) do nothing
  `,
  insertSession: `
    insert into myportal.sessions (user_id, token_hash, expires_at)
    values ($1, $2, $3)
    returning id
  `,
  findSession: `
    select s.id as session_id, s.expires_at, u.id as user_id, u.email
    from myportal.sessions s
    join myportal.users u on u.id = s.user_id
    where s.token_hash = $1
  `,
  deleteSession: `
    delete from myportal.sessions
    where token_hash = $1
  `,
  ensureUncategorized: `
    insert into myportal.categories (user_id, name, parent_id, sort_order)
    select $1, '미분류', null, 9999
    where not exists (
      select 1 from myportal.categories
      where user_id = $1 and name = '미분류' and parent_id is null
    )
    returning id
  `,
  findUncategorized: `
    select id from myportal.categories
    where user_id = $1 and name = '미분류' and parent_id is null
    limit 1
  `,
};
