-- Consolidate duplicate automatically-discovered limits before enforcing identity uniqueness.
-- Keep the oldest row as the canonical limit and preserve every historical reference.

CREATE TEMP TABLE _usage_limit_dedup (
  old_id TEXT PRIMARY KEY,
  new_id TEXT NOT NULL
);

INSERT INTO _usage_limit_dedup (old_id, new_id)
SELECT duplicate.id,
       (
         SELECT canonical.id
         FROM usage_limits AS canonical
         WHERE canonical.plan_id = duplicate.plan_id
           AND canonical.reset_rule = duplicate.reset_rule
         ORDER BY canonical.created_at ASC, canonical.id ASC
         LIMIT 1
       )
FROM usage_limits AS duplicate
WHERE duplicate.reset_rule IS NOT NULL
  AND trim(duplicate.reset_rule) <> ''
  AND duplicate.id <> (
    SELECT canonical.id
    FROM usage_limits AS canonical
    WHERE canonical.plan_id = duplicate.plan_id
      AND canonical.reset_rule = duplicate.reset_rule
    ORDER BY canonical.created_at ASC, canonical.id ASC
    LIMIT 1
  );

UPDATE usage_snapshots
SET limit_id = (SELECT new_id FROM _usage_limit_dedup WHERE old_id = usage_snapshots.limit_id)
WHERE limit_id IN (SELECT old_id FROM _usage_limit_dedup);

UPDATE usage_activities
SET limit_id = (SELECT new_id FROM _usage_limit_dedup WHERE old_id = usage_activities.limit_id)
WHERE limit_id IN (SELECT old_id FROM _usage_limit_dedup);

UPDATE reset_events
SET limit_id = (SELECT new_id FROM _usage_limit_dedup WHERE old_id = reset_events.limit_id)
WHERE limit_id IN (SELECT old_id FROM _usage_limit_dedup);

UPDATE notification_events
SET limit_id = (SELECT new_id FROM _usage_limit_dedup WHERE old_id = notification_events.limit_id)
WHERE limit_id IN (SELECT old_id FROM _usage_limit_dedup);

DELETE FROM usage_limits
WHERE id IN (SELECT old_id FROM _usage_limit_dedup);

DROP TABLE _usage_limit_dedup;

CREATE UNIQUE INDEX IF NOT EXISTS uq_usage_limits_plan_reset_rule
ON usage_limits (plan_id, reset_rule)
WHERE reset_rule IS NOT NULL AND trim(reset_rule) <> '';
