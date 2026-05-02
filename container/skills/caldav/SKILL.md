---
name: caldav
description: Read and modify the user's calendar via caldav-cli. Use whenever the user asks about scheduling, events, appointments, availability, or any calendar query — even implicit ones ("am I free Thursday?", "book lunch with…", "when is…"). The DB is kept fresh by a host-side timer — read directly, don't sync before reading.
allowed-tools: Bash(caldav-cli:*)
---

# Calendar via caldav-cli

`caldav-cli` is a local-first CalDAV client. Reads and writes hit a local SQLite DB. A host-side systemd timer (`caldav-sync.timer`) syncs that DB with the CalDAV server every 5 minutes and also refreshes any subscribed ICS feeds in the same cycle, so you can read directly — no sync call needed.

### ChronosHub calendar

ChronosHub is a read-only ICS subscription (calendar id `ics:chronoshub`, display name `ChronosHub (ICS)`). Its events only carry `Busy`/`Free`/`Tentative` summaries — no titles, attendees, or descriptions. Treat it as a free/busy source for availability queries, not a source of "what's the meeting about". If the user asks what their ChronosHub meeting is about, say you only have free/busy info.

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

Treat the DB as ~5 min stale at worst. If the user says "check right now", tell them you're on a 5-min pull cadence — forcing a pull from inside the container isn't available (no credentials here; see "Write pattern" for how pushes work).

## Write pattern — push via host IPC

The container config has no server credentials, so `sync run` inside the container will fail by design. Instead, after `event create`/`update`/`delete`, drop an IPC sentinel — the host runs `sync run` with its real config:

```bash
# Create an event locally, then ask the host to push
caldav-cli -c ... --json event create --calendar "Work" --summary "Lunch" \
  --start 2026-04-20T12:30:00 --end 2026-04-20T13:30:00
echo '{"type":"caldav_push"}' > /workspace/ipc/tasks/caldav_$(date +%s%N).json
```

Batch multiple writes before the final sentinel — one push picks up everything pending. If you forget the sentinel, the change still syncs on the host timer's next tick (~5 min).

## Commands

### Calendars

```bash
caldav-cli -c ... --json calendar list
```

`list` returns CalDAV-discovered calendars and any subscribed ICS feeds (`source_kind: "Ics"`, with `ics_url` populated).

Subscribing to an ICS feed and unsubscribing require real credentials / write access to the DB, so do them from the host, not inside the container. For reference:

```bash
# (host) subscribe to a read-only ICS feed
caldav-cli calendar subscribe --url <url> --name "Team Feed" [--id ics:team-feed] [--sync]
# (host) remove a subscription and its projected events
caldav-cli calendar unsubscribe <calendar_id>
```

### Events

```bash
# List in range (ISO 8601). Defaults: today → today+7d.
caldav-cli -c ... --json event list --from 2026-04-16 --to 2026-04-23
caldav-cli -c ... --json event list --calendar "Work" --from 2026-04-20

# Get single event
caldav-cli -c ... --json event get <event_id>

# Create (naive datetime → pair with --tz so it isn't interpreted as UTC)
caldav-cli -c ... --json event create \
  --calendar "Work" \
  --summary "Lunch with Sam" \
  --start 2026-04-20T12:30:00 \
  --end 2026-04-20T13:30:00 \
  --tz Europe/Berlin \
  --location "Cafe X"

# All-day
caldav-cli -c ... --json event create --calendar "Personal" \
  --summary "Off-site" --start 2026-04-25 --end 2026-04-25 --all-day

# Meeting with attendees (repeat --attendee per person; spec is
# "email[,role=req|opt|chair][,cn=Name]"). Organizer is required for iTIP.
caldav-cli -c ... --json event create --calendar "Work" \
  --summary "Design review" --start 2026-04-22T15:00:00 --end 2026-04-22T16:00:00 \
  --tz Europe/Berlin \
  --organizer aap@chronoshub.io \
  --attendee "sam@example.com,role=req,cn=Sam" \
  --attendee "kim@example.com,role=opt"

# Update (only pass fields that change; pass --tz whenever --start moves)
caldav-cli -c ... --json event update <event_id> --start 2026-04-20T13:00:00 --tz Europe/Berlin

# Inspect attendees and their PARTSTAT (accepted/declined/tentative/needs-action)
caldav-cli -c ... --json event attendees <event_id>

# Delete — local-only removal. Does NOT send CANCEL to attendees. Use for
# personal events you own outright, or drafts that were never pushed.
caldav-cli -c ... --json event delete <event_id>

# Cancel — the right call for meetings with attendees: sets STATUS=CANCELLED,
# bumps SEQUENCE, and queues a CANCEL iTIP so invitees get a retraction.
caldav-cli -c ... --json event cancel <event_id>

# Conflicts (when the sync engine detected a local/server divergence)
caldav-cli -c ... --json event conflicts
caldav-cli -c ... --json event resolve <event_id> --keep-local   # or --keep-server
```

Writes against ICS-subscribed calendars will fail — they're read-only.

**delete vs. cancel:** if `event attendees` returns a non-empty list, use `event cancel`, not `event delete`. Delete just drops the row locally; attendees never hear about it and will still show up.

### Scheduling inbox (iTIP replies)

Incoming meeting REQUESTs land in a local scheduling inbox. Respond via `invite`:

```bash
caldav-cli -c ... --json invite list                           # all inbox items
caldav-cli -c ... --json invite list --unprocessed             # only items awaiting a reply
caldav-cli -c ... --json invite show <inbox_id>                # parsed summary
caldav-cli -c ... --json invite show <inbox_id> --raw          # raw iTIP iCal (debug)
caldav-cli -c ... --json invite accept <inbox_id>              # PARTSTAT=ACCEPTED
caldav-cli -c ... --json invite accept <inbox_id> --comment "see you there"
caldav-cli -c ... --json invite decline <inbox_id>             # PARTSTAT=DECLINED
caldav-cli -c ... --json invite tentative <inbox_id>           # PARTSTAT=TENTATIVE
```

Only `REQUEST` items are replyable — REPLY/CANCEL entries are informational.

Like event writes, the REPLY only leaves the device after the next host-side `sync run` — drop the `caldav_push` IPC sentinel if the user wants it sent now.

### Diagnostics

```bash
caldav-cli -c ... --json sync status    # last sync, pending changes, daemon state
caldav-cli -c ... --json config show    # config (no real password — host owns creds)
```

If `sync status` shows `last_sync_at` more than ~10 minutes old, the host timer has failed — report that to the user. Drop the `caldav_push` IPC sentinel to trigger an immediate host-side sync if needed.

Don't run `config test` inside the container — it needs real credentials and will fail.

## Date handling

- ISO 8601 everywhere: `2026-04-20T14:00:00` for datetimes, `2026-04-20` for all-day.
- System timezone is the user's local (TZ is passed into the container) — use it to resolve natural language.
- For `event create`/`update`, pass `--tz` with an IANA name (e.g. `Europe/Berlin`) whenever you set a naive `--start`/`--end`. Without `--tz` the wall-clock time is resolved in the container's local tz and stored as a floating UTC datetime with no `TZID` — other CalDAV clients render that inconsistently across DST. An explicit offset suffix (`…+02:00`, `…Z`) in the datetime overrides `--tz`.
- Resolve natural language ("tomorrow 2pm") to an absolute ISO string yourself before passing to `caldav-cli`.

## Availability queries

For "am I free X?", list events in that range and check for overlap. Don't guess — list.

```bash
caldav-cli -c ... --json event list --from 2026-04-20T09:00:00 --to 2026-04-20T18:00:00
```

## Errors

- `No profile specified` → check `config show`; default profile may be missing.
- `Failed to read config file` → config.toml path is wrong. Should always be `/workspace/group/.caldav/config.toml`.
- Auth error / 401 on `sync run` → expected: the container has no real credentials. Drop the `caldav_push` sentinel instead.
- Conflict on write → `event conflicts`, resolve explicitly.
- Write against an ICS-subscribed calendar → read-only; pick a CalDAV calendar instead.
- `Cannot reply to a REPLY/CANCEL inbox item` → only REQUEST items are replyable; informational entries don't need a response.

## Don't

- Don't run `sync start` — the host timer owns syncing.
- Don't run `sync run` inside the container — it will fail (no credentials). Drop the IPC sentinel instead (see "Write pattern").
- Don't try to edit `config.toml` — the mount is read-only and contains no real credentials anyway.
- Don't invent event IDs. Get them from `list` or `get`.
- Don't try to `calendar subscribe`/`unsubscribe` from inside the container — do it on the host.
- Don't `event delete` a meeting that has attendees — use `event cancel` so a CANCEL iTIP goes out. Delete is local-only.
