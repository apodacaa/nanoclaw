---
name: imap
description: Read and send email via imap (local-first IMAP/SMTP CLI). Use whenever the user asks about inbox, messages, drafts, sending or replying to mail, or any mailbox-adjacent query — including implicit ones ("did Sam email me back?", "reply to the ticket from ops"). The DB is kept fresh by a host-side timer — read directly, don't sync before reading.
allowed-tools: Bash(imap:*)
---

# Email via imap

`imap` is a local-first IMAP/SMTP client. Reads hit a local SQLite DB; writes (compose, reply, drafts, flag changes) append to a local outbox. A host-side systemd timer (`imap-sync.timer`) pulls new mail and drains the SMTP outbox every 3 minutes.

## Config

A per-group config lives at `/workspace/group/.imap/config.toml`. The DB it points at is mounted at `/var/lib/imap-cli/imap.db` (shared, kept fresh by the host timer).

Always pass `-c` and `--json`:

```bash
imap -c /workspace/group/.imap/config.toml --json <command>
```

`--json` gives machine-parseable output — no colors, no prose.

## Read pattern — no sync needed

The host timer keeps the DB current. Just read:

```bash
imap -c /workspace/group/.imap/config.toml --json message list --mailbox INBOX --unread
```

Treat the DB as ~3 min stale at worst. If the user says "check right now", tell them you're on a 3-min pull cadence — forcing a pull from inside the container isn't available (no credentials; drop the `imap_push` sentinel, next section).

## Write pattern — push via host IPC

The container config has no real server credentials, so `sync run` inside the container will fail by design. Instead, after `send`/`reply`/`forward`/`draft send`/flag changes, drop an IPC sentinel — the host runs `sync run` with its real config:

```bash
imap -c ... --json send --to sam@example.com --subject "Re: lunch" --body "Works for me."
echo '{"type":"imap_push"}' > /workspace/ipc/tasks/imap_$(date +%s%N).json
```

Batch multiple writes before the final sentinel — one push drains the whole outbox. If you forget the sentinel, the change still goes out on the host timer's next tick (~3 min).

## Commands

### Mailboxes

```bash
imap -c ... --json mailbox list
```

### Messages

```bash
# List (defaults: INBOX, 50 rows)
imap -c ... --json message list --mailbox INBOX
imap -c ... --json message list --unread
imap -c ... --json message list --since 2026-04-15 --limit 20

# Show a single message (use id from list output)
imap -c ... --json message show <id>
imap -c ... --json message show <id> --headers    # include all headers
imap -c ... --json message show <id> --raw        # raw RFC 5322 source

# Local-cache search (subject/from/body)
imap -c ... --json message search "invoice"
imap -c ... --json message search "ops" --mailbox Archive

# Flags / state
imap -c ... --json message read <id>              # mark \Seen
imap -c ... --json message unread <id>
imap -c ... --json message flag <id>              # add \Flagged
imap -c ... --json message unflag <id>

# Move / delete (delete marks \Deleted; expunged on next sync)
imap -c ... --json message move <id> --to Archive
imap -c ... --json message delete <id>
```

### Compose, reply, forward

Body via `--body` (inline) or `--body-file` (path to a UTF-8 text file). For anything longer than a sentence, write it to a file first so newlines and quoting survive.

```bash
# New message
imap -c ... --json send \
  --to sam@example.com --cc kim@example.com \
  --subject "Design review notes" \
  --body-file /tmp/body.txt \
  --attach /workspace/group/screenshot.png

# Reply (quotes original; --all for reply-all)
imap -c ... --json reply <id> --all --body-file /tmp/reply.txt

# Forward
imap -c ... --json forward <id> --to newperson@example.com --body-file /tmp/note.txt
```

After any send/reply/forward, drop the `imap_push` sentinel if the user wants it out immediately.

### Drafts

```bash
# Save (same flags as `send`, but doesn't queue)
imap -c ... --json draft save --to sam@example.com --subject "WIP" --body-file /tmp/draft.txt

# List drafts
imap -c ... --json draft list

# Send an existing draft (moves it to the outbox → drained on next sync)
imap -c ... --json draft send <draft_id>
```

### Diagnostics

```bash
imap -c ... --json sync status    # last sync, pending outbox, daemon state
imap -c ... --json config show    # config (password masked; host owns real creds)
```

If `sync status` shows the last sync >10 min ago, the host timer has failed — tell the user. Don't run `config test` inside the container; it needs real credentials and will fail.

## Don't

- Don't run `sync start`/`sync stop` — the host timer owns syncing.
- Don't run `sync run` inside the container — it will fail (no credentials). Drop the `imap_push` IPC sentinel instead.
- Don't try to edit `config.toml` — the mount is read-only and contains no real credentials anyway.
- Don't invent message ids — get them from `message list`/`search`.
- Don't paste long bodies inline with `--body` — use `--body-file` so newlines and shell quoting don't mangle the message.

## Etiquette

- Quote only what you need in replies — the CLI already includes the canonical "On X, Y wrote:" header.
- Prefer `message read` after showing a message only if the user actually read it (via you). Don't silently mark things seen.
- For sensitive content, confirm with the user before sending rather than dropping the push sentinel automatically.
