-- Let existing channels fall through to the trimmed default event set.
--
-- Onboarding used to write every event type into a channel's event_preferences, including
-- reset_expected and exhaustion_forecast. Those two are now off by default: they fire on states
-- that usually resolve themselves ("預計重置時間到了但還沒讀到新資料", "可能在重置前用完"), so they
-- arrive far more often than they turn out to matter. Because the rows carry an explicit `true`,
-- changing the default alone would not reach them.
--
-- Only the two keys are removed. Anything the user actually toggled — including turning these two
-- back on after this migration — is an explicit value that survives, and the channel keeps every
-- other preference it had.
UPDATE notification_channels
SET event_preferences = json_remove(event_preferences, '$.reset_expected', '$.exhaustion_forecast')
WHERE event_preferences IS NOT NULL
  AND json_valid(event_preferences);
