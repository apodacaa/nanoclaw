#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-agent"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-container}"

# Build third-party binaries that get baked into the image.
# caldav-cli: expected at ../../caldav-cli relative to this script (sibling of nanoclaw repo).
CALDAV_SRC="$SCRIPT_DIR/../../caldav-cli"
CALDAV_TARGET="x86_64-unknown-linux-musl"
if [ -d "$CALDAV_SRC" ]; then
  echo "Building caldav-cli (target: $CALDAV_TARGET) from $CALDAV_SRC..."
  # Static musl build — portable across any Linux glibc version in the runtime image.
  # Requires: rustup target add x86_64-unknown-linux-musl && apt install musl-tools
  (cd "$CALDAV_SRC" && cargo build --release --target "$CALDAV_TARGET")
  cp "$CALDAV_SRC/target/$CALDAV_TARGET/release/caldav-cli" "$SCRIPT_DIR/bin/caldav-cli"
  echo "  -> $SCRIPT_DIR/bin/caldav-cli ($(du -h "$SCRIPT_DIR/bin/caldav-cli" | cut -f1))"
else
  echo "caldav-cli source not found at $CALDAV_SRC — skipping (image will lack caldav-cli)"
fi

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

${CONTAINER_RUNTIME} build -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
