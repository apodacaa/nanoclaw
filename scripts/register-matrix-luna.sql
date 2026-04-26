-- Registers the matrix_luna group (Luna Danish tutor for Kerri-Ann).
--
-- Run with:
--   sqlite3 /root/nanoclaw/store/messages.db < scripts/register-matrix-luna.sql
--
-- Then restart NanoClaw so it picks up the new group.
--
-- Bot login: shared with Ken (MATRIX_BOT_2). Mirrors how Leo shares Ivy
-- (MATRIX_BOT_1) — one Matrix account serves multiple rooms with different
-- personas via per-group CLAUDE.md.
--
-- The containerConfig payload:
--   - additionalMounts: read-only mount of the level-4 course tree as
--                       /workspace/extra/course/ (parallels Leo's mount of
--                       /root/d2g/output)
--   - global=false:     don't mount /workspace/global; Luna is sandboxed
--   - timezone:         Europe/Copenhagen
--
-- IMPORTANT: replace <ROOM_JID_HERE> with the JID of the new Matrix room
-- before running. The room is created by:
--   1. Logging in to the homeserver as Ken (MATRIX_BOT_2)
--   2. POST /_matrix/client/v3/createRoom (private, invite Kerri-Ann)
--   3. Pasting the returned room_id (with mx: prefix) below
--
-- The mount allowlist at ~/.config/nanoclaw/mount-allowlist.json must already
-- include /root/d2g/output-level4 (added 2026-04-26).

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
  'mx:!4c4c34f7543905ca1676626f:100.111.92.11',
  'Luna',
  'matrix_luna',
  '@Luna',
  datetime('now'),
  json('{
    "additionalMounts": [
      {
        "hostPath":      "/root/d2g/output-level4",
        "containerPath": "course",
        "readonly":      true
      }
    ],
    "global":   false,
    "timezone": "Europe/Copenhagen"
  }'),
  0,
  0
);
