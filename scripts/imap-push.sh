#!/usr/bin/env bash
#
# Sync IMAP + drain the SMTP outbox. Invoked by the IPC `imap_push` task
# after the container agent composes/replies/drafts→sends. Runs on the host
# with the real credentials in ~/.config/imap-cli/config.toml — the
# container never sees them.

set -euo pipefail

# Absolute path: imap is not on the default PATH on this host. The systemd
# unit imap-sync.service uses this same absolute path.
IMAP_CLI="${IMAP_CLI:-/root/imap-cli/target/release/imap}"

exec "$IMAP_CLI" -c "$HOME/.config/imap-cli/config.toml" --json sync run
