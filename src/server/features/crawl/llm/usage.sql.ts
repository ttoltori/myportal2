export const llmUsageSql = {
  countTodayByUser: `
    select count(*)::text as count
    from myportal.llm_calls
    where user_id = $1 and ok = true and created_at >= current_date
  `,
  countTodaySystem: `
    select count(*)::text as count
    from myportal.llm_calls
    where user_id is null and ok = true and created_at >= current_date
  `,
  insertCall: `
    insert into myportal.llm_calls
        (user_id, source_id, purpose, model, prompt_tokens, completion_tokens, duration_ms, ok, error_code)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  `,
};
