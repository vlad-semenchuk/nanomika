#!/bin/bash
# Build the NanoMika agent container image.
#
# Reads one optional build flag from ../.env:
#   INSTALL_CJK_FONTS=true   — add Chinese/Japanese/Korean fonts (~200MB)
# Callers can also override by exporting INSTALL_CJK_FONTS directly.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Physical path (pwd -P): the host hashes process.cwd(), which resolves
# symlinks, so the image name must be computed from the same path.
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
cd "$SCRIPT_DIR"

# Derive the image name from the project root so two NanoMika installs on the
# same host don't overwrite each other's image tag. Matches
# getContainerImageBase() in src/install-slug.ts: nanomika-agent-v2-<sha1(root)[:8]>.
# CONTAINER_IMAGE_BASE in the caller's env overrides (same as src/config.ts).
if [ -n "${CONTAINER_IMAGE_BASE:-}" ]; then
    IMAGE_NAME="$CONTAINER_IMAGE_BASE"
else
    if command -v shasum >/dev/null 2>&1; then
        INSTALL_SLUG="$(printf '%s' "$PROJECT_ROOT" | shasum -a 1 | cut -c 1-8)"
    else
        INSTALL_SLUG="$(printf '%s' "$PROJECT_ROOT" | sha1sum | cut -c 1-8)"
    fi
    IMAGE_NAME="nanomika-agent-v2-${INSTALL_SLUG}"
fi
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

# Caller's env takes precedence; fall back to .env.
if [ -z "${INSTALL_CJK_FONTS:-}" ] && [ -f "../.env" ]; then
    INSTALL_CJK_FONTS="$(grep '^INSTALL_CJK_FONTS=' ../.env | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '[:space:]')"
fi

BUILD_ARGS=()
if [ "${INSTALL_CJK_FONTS:-false}" = "true" ]; then
    echo "CJK fonts: enabled (adds ~200MB)"
    BUILD_ARGS+=(--build-arg INSTALL_CJK_FONTS=true)
fi

echo "Building NanoMika agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

${CONTAINER_RUNTIME} build "${BUILD_ARGS[@]}" -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
