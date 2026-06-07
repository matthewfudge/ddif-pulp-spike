#!/usr/bin/env bash
# setup-pulp.sh — bootstrap the Pulp UI stack for DDIF.
#
# Clones (or fast-forwards) the three Pulp repos, switches `pulp` to the
# embedding seam branch, builds it in Release, and installs the SDK.
# After this you can configure DDIF with:
#
#   cmake -B Build/DreamDateFX-Pulp -G Ninja -S Projects/DreamDateFX \
#         -DCMAKE_BUILD_TYPE=Debug -DDDD_USE_PULP_UI=ON
#
# All paths are configurable via env vars (defaults shown):
#   PULP_ROOT          /Volumes/Areas/Development/SDK/Pulp
#   PULP_SDK_INSTALL   $PULP_ROOT/install
#   PULP_SEAM_BRANCH   explore/foreign-host-embed
#   FORK_USER          matthewfudge   (origin remote owner; upstream stays danielraffel)
#
# This script is idempotent: re-running pulls latest seam, rebuilds only
# what changed, and reinstalls.

set -euo pipefail

PULP_ROOT="${PULP_ROOT:-/Volumes/Areas/Development/SDK/Pulp}"
PULP_SDK_INSTALL="${PULP_SDK_INSTALL:-$PULP_ROOT/install}"
PULP_SEAM_BRANCH="${PULP_SEAM_BRANCH:-explore/foreign-host-embed}"
FORK_USER="${FORK_USER:-matthewfudge}"
JOBS="${JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || echo 4)}"

log() { printf '  \033[1;36m▶\033[0m %s\n' "$*"; }
ok()  { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
warn(){ printf '  \033[1;33m⚠\033[0m %s\n' "$*"; }
die() { printf '  \033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

step() { printf '\n\033[1m── %s ──\033[0m\n' "$*"; }

step "Preflight"
[[ "$(uname)" == "Darwin" ]] || die "Pulp UI is macOS-only today"
command -v git    >/dev/null || die "git not found"
command -v cmake  >/dev/null || die "cmake not found"
command -v ninja  >/dev/null || warn "ninja not found — CMake will fall back to Make"
command -v gh     >/dev/null || warn "gh CLI not found — fork sync will use plain git only"
ok "tools present"

mkdir -p "$PULP_ROOT"
ok "PULP_ROOT = $PULP_ROOT"

clone_or_update() {
    local repo=$1
    local dir="$PULP_ROOT/$repo"
    if [[ ! -d "$dir/.git" ]]; then
        log "cloning $repo from fork ($FORK_USER/$repo)"
        git clone "https://github.com/$FORK_USER/$repo.git" "$dir"
        git -C "$dir" remote add upstream "https://github.com/danielraffel/$repo.git"
        git -C "$dir" remote set-url --push upstream DISABLED_pushes_go_to_origin
        git -C "$dir" fetch upstream --quiet
    else
        log "$repo: fetching upstream"
        git -C "$dir" fetch upstream --quiet
    fi
    ok "$repo ready"
}

step "Clone or update Pulp repos"
clone_or_update pulp
clone_or_update pulp-view-embed
clone_or_update pulp-embed-juce

step "Switch pulp to the embedding seam branch"
cd "$PULP_ROOT/pulp"
# Use a local 'seam' branch tracking upstream/<seam>. If you have local commits
# on top (a feature branch on the fork), rebase manually before running.
log "checkout seam -> upstream/$PULP_SEAM_BRANCH"
git checkout -B seam "upstream/$PULP_SEAM_BRANCH"
ok "pulp on $(git log -1 --format='%h %s')"

step "Build Pulp SDK (Release, no tests/examples)"
if [[ -d build-release ]] && [[ "$(cat build-release/CMakeCache.txt 2>/dev/null | grep -c CMAKE_BUILD_TYPE:STRING=Release)" -gt 0 ]]; then
    log "build-release/ exists and is Release — incremental build"
else
    log "fresh configure"
    rm -rf build-release
    cmake -B build-release -S . \
        -DCMAKE_BUILD_TYPE=Release \
        -DPULP_BUILD_TESTS=OFF \
        -DPULP_BUILD_EXAMPLES=OFF \
        -G Ninja
fi
nice -n 10 cmake --build build-release -j "$JOBS"
ok "Pulp build complete"

step "Install Pulp SDK to $PULP_SDK_INSTALL"
rm -rf "$PULP_SDK_INSTALL"
cmake --install build-release --prefix "$PULP_SDK_INSTALL" >/dev/null
[[ -f "$PULP_SDK_INSTALL/lib/cmake/Pulp/PulpConfig.cmake" ]] \
    || die "install failed — PulpConfig.cmake not produced"
ok "SDK installed; sdk_build_type=$(cat "$PULP_SDK_INSTALL/sdk_build_type.txt")"

step "Done"
ok "PULP_SDK_INSTALL_DIR=$PULP_SDK_INSTALL"
ok "PULP_VIEW_EMBED_DIR=$PULP_ROOT/pulp-view-embed"
ok "PULP_EMBED_JUCE_DIR=$PULP_ROOT/pulp-embed-juce"
printf '\nConfigure DDIF with Pulp enabled:\n'
printf '  cmake -B Build/DreamDateFX-Pulp -G Ninja -S Projects/DreamDateFX \\\n'
printf '        -DCMAKE_BUILD_TYPE=Debug -DDDD_USE_PULP_UI=ON\n'
printf '  ninja -C Build/DreamDateFX-Pulp\n'
