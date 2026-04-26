-- Registers the matrix_wife group (Ken assistant for Kerri-Ann).
--
-- Run with:
--   sqlite3 /root/nanoclaw/store/messages.db < scripts/register-matrix-wife.sql
--
-- Then restart NanoClaw so it picks up the new group + the new MATRIX_BOT_2_*
-- env vars (Ken bot won't connect until restart).
--
-- The containerConfig payload:
--   - caldavStateDir / imapStateDir / imap=true: isolate her on her own DBs
--   - global=false:                              don't mount /workspace/global
--   - timezone="Europe/Copenhagen":              correct TZ for Copenhagen
--
-- IMPORTANT: imapStateDir + imap=true are included even though the IMAP host
-- (iCloud vs Gmail) is still being decided. The container won't actually have
-- a usable mailbox until ~/.config/imap-cli/wife.toml is filled in and the
-- imap-sync-wife.timer is enabled. If we drop IMAP support entirely, remove
-- imap and imapStateDir from the JSON below before running.

INSERT OR REPLACE INTO registered_groups (
  jid,
  name,
  folder,
  trigger_pattern,
  added_at,
  container_config,
  requires_trigger,
  is_main
) VALUES (
  'mx:!4dca1beca96bf3fa5c31c9b6:100.111.92.11',
  'Ken',
  'matrix_wife',
  '@Ken',
  datetime('now'),
  json('{
    "caldavStateDir": "~/.local/share/caldav-cli-wife",
    "imapStateDir":   "~/.local/share/imap-cli-wife",
    "imap":           true,
    "global":         false,
    "timezone":       "Europe/Copenhagen"
  }'),
  0,
  0
);
