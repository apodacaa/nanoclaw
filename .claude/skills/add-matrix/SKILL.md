---
name: add-matrix
description: Add Matrix as a channel. Connects to a self-hosted Matrix homeserver. Use Element (or any Matrix client) on your phone to chat with NanoClaw. Can run alongside other channels.
---

# Add Matrix Channel

This skill adds Matrix support to NanoClaw, then walks through interactive setup. Designed for a self-hosted Matrix homeserver (e.g., the Go server at ../matrix) with Cloudflare Tunnel for public TLS access.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/channels/matrix.ts` exists. If it does, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

AskUserQuestion: What is your Matrix homeserver URL? (e.g., http://localhost:8008 for local, or https://yourdomain.com if behind a tunnel)

## Phase 2: Apply Code Changes

### Verify files exist

These files should already be present (they ship on main):
- `src/channels/matrix.ts` (MatrixChannel class with self-registration)
- `import './matrix.js'` in `src/channels/index.ts`

If `src/channels/matrix.ts` is missing, something went wrong — check git status.

### Validate code changes

```bash
npm run build
```

Build must be clean before proceeding.

## Phase 3: Setup

### Create bot account on the homeserver

The bot needs its own Matrix account. Two paths:

**Option A — Register a new account (if server allows open registration):**

```bash
curl -s -X POST <HOMESERVER_URL>/_matrix/client/v3/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"nanoclaw","password":"<generate-a-strong-password>"}'
```

If the server returns a UIAA flow with a `session`, complete it:

```bash
curl -s -X POST <HOMESERVER_URL>/_matrix/client/v3/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"nanoclaw","password":"<password>","auth":{"type":"m.login.dummy","session":"<session-from-above>"}}'
```

If registration succeeds, note the `user_id` and `access_token` in the response.

**Option B — Log in to an existing account:**

```bash
curl -s -X POST <HOMESERVER_URL>/_matrix/client/v3/login \
  -H 'Content-Type: application/json' \
  -d '{"type":"m.login.password","user":"nanoclaw","password":"<password>"}'
```

### Configure environment

Add to `.env`. Bots use numbered credentials (`MATRIX_BOT_1_*`, `MATRIX_BOT_2_*`, etc.):

```bash
MATRIX_BASE_URL=<homeserver-url>
MATRIX_BOT_1_USERNAME=nanoclaw
MATRIX_BOT_1_PASSWORD=<password>
```

To add more bots for separate purposes, add additional numbered entries:

```bash
MATRIX_BOT_2_USERNAME=researcher
MATRIX_BOT_2_PASSWORD=<password>
MATRIX_BOT_3_USERNAME=scheduler
MATRIX_BOT_3_PASSWORD=<password>
```

Each bot gets its own channel instance (`matrix`, `matrix-2`, `matrix-3`), its own sync loop, and auto-joins rooms it's invited to. The channel handles registration/login at startup automatically.

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

### Build and restart

```bash
npm run build
```

Restart the service:

```bash
# Linux:
systemctl --user restart nanoclaw
# macOS:
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 4: Create and Register Room

### Get bot access token

Log in as the bot to get an access token for room creation:

```bash
ACCESS_TOKEN=$(curl -s -X POST <HOMESERVER_URL>/_matrix/client/v3/login \
  -H 'Content-Type: application/json' \
  -d '{"type":"m.login.password","user":"<bot-username>","password":"<bot-password>"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")
echo "Token: $ACCESS_TOKEN"
```

### Ask the user

AskUserQuestion: What should the room be called? (default: "NanoClaw Main")

AskUserQuestion: What is your Matrix username? (e.g., `alice` — needed to invite you to the room)

### Create the room and invite the user

```bash
ROOM_ID=$(curl -s -X POST <HOMESERVER_URL>/_matrix/client/v3/createRoom \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"<room-name>","invite":["@<username>:<homeserver-domain>"]}' | python3 -c "import sys,json; print(json.load(sys.stdin)['room_id'])")
echo "Room ID: $ROOM_ID"
```

The `invite` field in `createRoom` is best-effort — some homeservers silently ignore it. Always follow up with an explicit invite:

```bash
curl -s -X POST <HOMESERVER_URL>/_matrix/client/v3/rooms/$(python3 -c "import urllib.parse; print(urllib.parse.quote('$ROOM_ID'))")/invite \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"user_id":"@<username>:<homeserver-domain>"}'
```

Tell the user to check Element for the invite.

### Register the room in NanoClaw

For the main room (responds to all messages):

```bash
npx tsx setup/index.ts --step register -- \
  --jid "mx:$ROOM_ID" \
  --name "<room-name>" \
  --folder "matrix_main" \
  --trigger "@${ASSISTANT_NAME}" \
  --channel matrix \
  --no-trigger-required \
  --is-main
```

For additional rooms (trigger-only):

```bash
npx tsx setup/index.ts --step register -- \
  --jid "mx:<room-id>" \
  --name "<room-name>" \
  --folder "matrix_<name>" \
  --trigger "@${ASSISTANT_NAME}" \
  --channel matrix
```

## Phase 5: Verify

### Test the connection

Tell the user:

> Open Element (or your Matrix client) and send a message in the registered room. For main rooms any message works; for non-main rooms, start with `@Andy` (or your trigger).
>
> The bot should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

Look for `Matrix bot logged in` or `Matrix bot registered` at startup, and `Matrix message stored` when messages arrive.

## Troubleshooting

### Bot not responding

1. Verify homeserver is running: `curl <HOMESERVER_URL>/_matrix/client/versions`
2. Verify credentials work: `curl -s -X POST <HOMESERVER_URL>/_matrix/client/v3/login -H 'Content-Type: application/json' -d '{"type":"m.login.password","user":"nanoclaw","password":"<password>"}'`
3. Check `.env` has `MATRIX_BASE_URL` and at least `MATRIX_BOT_1_USERNAME` + `MATRIX_BOT_1_PASSWORD`, AND is synced to `data/env/env`
4. Check room is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'mx:%'"`
5. Service is running: `systemctl --user status nanoclaw` (Linux) or `launchctl list | grep nanoclaw` (macOS)

### Bot not auto-joining invites

The bot auto-joins rooms it's invited to during the sync loop. If it's not joining:
- Verify the bot account exists on the homeserver
- Check that the homeserver supports the invite endpoint (`POST /rooms/{roomId}/invite`)
- Check logs for "Matrix failed to auto-join room" errors

### Messages replayed after restart

The sync token is persisted to `data/matrix-sync-token.txt`. If this file is lost (or the homeserver was restarted and lost in-memory state), the bot does a fresh initial sync and skips messages older than its startup time. No duplicates should occur, but any messages sent while the bot was down may be missed.

### Homeserver restarted (in-memory server)

If the homeserver uses in-memory storage, all rooms and accounts are lost on restart. You'll need to:
1. Re-register the bot account (happens automatically on NanoClaw restart)
2. Re-create rooms and re-invite the bot
3. Re-register with new room IDs (old `mx:!...` JIDs are stale)
4. Delete the stale sync token: `rm data/matrix-sync-token.txt`

### Cloudflare Tunnel setup

To access the homeserver from Element on your phone:

```bash
cloudflared tunnel --url http://localhost:8008
```

Use the tunnel URL as your homeserver in Element's custom server settings. Set `MATRIX_BASE_URL` in `.env` to this URL (or the homeserver's public domain) so the bot connects via the same path.

## After Setup

If running `npm run dev` while the service is active:

```bash
# Linux:
systemctl --user stop nanoclaw
npm run dev
# When done:
systemctl --user start nanoclaw

# macOS:
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
npm run dev
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

## Removal

To remove Matrix integration:

1. Delete `src/channels/matrix.ts`
2. Remove `import './matrix.js'` from `src/channels/index.ts`
3. Remove `MATRIX_BASE_URL`, `MATRIX_BOT_1_USERNAME`, `MATRIX_BOT_1_PASSWORD` (and any `MATRIX_BOT_N_*`) from `.env`
4. Remove Matrix registrations: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'mx:%'"`
5. Remove sync token: `rm -f data/matrix-sync-token.txt`
6. Rebuild: `npm run build && systemctl --user restart nanoclaw` (Linux) or `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS)
