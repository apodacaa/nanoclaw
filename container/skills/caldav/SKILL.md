---
name: caldav
description: Read and modify the user's calendar via caldav-cli. Use whenever the user asks about scheduling, events, appointments, availability, or any calendar query — even implicit ones ("am I free Thursday?", "book lunch with…", "when is…"). The DB is kept fresh by a host-side timer — read directly, don't sync before reading.
allowed-tools: Bash(caldav-cli:*)
---

# Calendar via caldav-cli

`caldav-cli` is a local-first CalDAV client. Reads and writes hit a local SQLite DB. A host-side systemd timer (`caldav-sync.timer`) syncs that DB with Mailbox.org every 5 minutes, so you can read directly — no sync call needed.

### ChronosHub calendar — use `ics:chronoshub`, not the Mailbox.org one

Two calendars with "ChronosHub" in the name exist:

- **`ics:chronoshub`** (display name `ChronosHub (ICS)`) — fetched directly from the Outlook ICS feed by `chronoshub-ics-sync.timer` every 15 minutes. **This is the authoritative ChronosHub calendar — use it.**
- **`/caldav/Y2FsOi8vOS8w/`** (display name `ChronosHub`) — a stale Mailbox.org-side subscription to the same feed, kept intentionally so the calendar stays visible in the user's Mailbox.org web UI / other CalDAV clients. **Ignore it for queries.** If you list events across all calendars, you may see duplicate busy blocks — this is harmless for availability checks but prefer `--calendar ics:chronoshub` for any ChronosHub-specific query.

ChronosHub events only carry `Busy`/`Free`/`Tentative` summaries — no titles, attendees, or descriptions. Treat it as a free/busy source for availability queries, not a source of "what's the meeting about". If the user asks what their ChronosHub meeting is about, say you only have free/busy info.

## Config

A per-group config lives at `/workspace/group/.caldav/config.toml`. The DB it points at is mounted at `/var/lib/caldav-cli/caldav.db` (shared, kept fresh by the host timer).

Always pass `-c` and `--json`:

```bash
caldav-cli -c /workspace/group/.caldav/config.toml --json <command>
```

`--json` gives machine-parseable output (no colors, no prose).

## Read pattern — no sync needed

The host timer keeps the DB current. Just read:

```bash
caldav-cli -c /workspace/group/.caldav/config.toml --json event list --from 2026-04-16 --to 2026-04-23
```

Treat the DB as ~5 min stale at worst. If the user explicitly says "check right now" or needs up-to-the-second accuracy, you can force a pull with `sync run`, but don't do it reflexively.

## Write pattern — push after mutating

After `event create`/`update`/`delete`, call `sync run` once to push your change to the server immediately. Without this, the change sits locally until the next timer tick.

```bash
# Create an event, then push
caldav-cli -c ... --json event create --calendar "Work" --summary "Lunch" \
  --start 2026-04-20T12:30:00 --end 2026-04-20T13:30:00
caldav-cli -c ... --json sync run
```

Batch multiple writes before the final `sync run` when you can.

## Commands

### Calendars

```bash
caldav-cli -c ... --json calendar list
```

### Events

```bash
# List in range (ISO 8601). Defaults: today → today+7d.
caldav-cli -c ... --json event list --from 2026-04-16 --to 2026-04-23
caldav-cli -c ... --json event list --calendar "Work" --from 2026-04-20

# Get single event
caldav-cli -c ... --json event get <event_id>

# Create
caldav-cli -c ... --json event create \
  --calendar "Work" \
  --summary "Lunch with Sam" \
  --start 2026-04-20T12:30:00 \
  --end 2026-04-20T13:30:00 \
  --location "Cafe X"

# All-day
caldav-cli -c ... --json event create --calendar "Personal" \
  --summary "Off-site" --start 2026-04-25 --end 2026-04-25 --all-day

# Update (only pass fields that change)
caldav-cli -c ... --json event update <event_id> --start 2026-04-20T13:00:00

# Delete
caldav-cli -c ... --json event delete <event_id>

# Conflicts (when the sync engine detected a local/server divergence)
caldav-cli -c ... --json event conflicts
caldav-cli -c ... --json event resolve <event_id> --keep-local   # or --keep-server
```

### Diagnostics

```bash
caldav-cli -c ... --json sync status    # last sync, pending changes, daemon state
caldav-cli -c ... --json config show    # config without password
caldav-cli -c ... --json config test    # verify server reachability
```

If `sync status` shows `last_sync_at` more than ~10 minutes old, the host timer has failed — report that to the user rather than papering over it with `sync run`. Note `sync status` only reflects the Mailbox.org sync; the ChronosHub ICS sync runs via a separate host timer (`chronoshub-ics-sync.timer`, 15 min cadence) and isn't visible here.

## Date handling

- ISO 8601 everywhere: `2026-04-20T14:00:00` for datetimes, `2026-04-20` for all-day.
- System timezone is the user's local (TZ is passed into the container).
- Resolve natural language ("tomorrow 2pm") to an absolute ISO string yourself before passing to `caldav-cli`.

## Availability queries

For "am I free X?", list events in that range and check for overlap. Don't guess — list.

```bash
caldav-cli -c ... --json event list --from 2026-04-20T09:00:00 --to 2026-04-20T18:00:00
```

## Errors

- `No profile specified` → check `config show`; default profile may be missing.
- `Failed to read config file` → config.toml path is wrong. Should always be `/workspace/group/.caldav/config.toml`.
- `Failed to connect` (only relevant to `sync run`) → `config test` for the full handshake error.
- Conflict on write → `event conflicts`, resolve explicitly.

## Don't

- Don't run `sync start` — the host timer owns syncing.
- Don't run `sync run` before reads. The timer handles it.
- Don't modify `config.toml` unless asked. Password is cleartext there.
- Don't invent event IDs. Get them from `list` or `get`.
