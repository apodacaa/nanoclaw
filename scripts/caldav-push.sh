#!/usr/bin/env bash
#
# Push pending local CalDAV writes to the server. Invoked by the IPC
# `caldav_push` task after the container agent creates/updates/deletes an
# event. Runs on the host with the real credentials in
# ~/.config/caldav-cli/config.toml — the container never sees them.

set -euo pipefail

# Absolute path: caldav-cli is not on the default PATH on this host. The
# systemd unit caldav-sync.service uses this same absolute path.
CALDAV_CLI="${CALDAV_CLI:-/root/caldav-cli/target/release/caldav-cli}"

exec "$CALDAV_CLI" -c "$HOME/.config/caldav-cli/config.toml" --json sync run
