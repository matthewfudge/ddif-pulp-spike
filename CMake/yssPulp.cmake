# yssPulp.cmake — opt-in Pulp embed integration for YSS-based plugins.
#
# Currently lives inside DDIF for the experiment/pulp-embed spike. Once the
# approach is proven it should move to <YSS>/CMake/yssPulp.cmake so every
# YSS project can include it the same way.
#
# Usage from a plugin's CMakeLists.txt (after juce_add_plugin):
#
#   if(DDD_USE_PULP_UI)
#       include("${CMAKE_CURRENT_LIST_DIR}/../../CMake/yssPulp.cmake")
#       yss_link_pulp(MyPluginTarget)
#   endif()
#
# Required CMake / env vars (all default to /Volumes/Areas/Development/SDK/Pulp/...):
#   PULP_SDK_INSTALL_DIR   — output of `cmake --install pulp/build --prefix ...`
#   PULP_VIEW_EMBED_DIR    — checkout of github.com/danielraffel/pulp-view-embed
#   PULP_EMBED_JUCE_DIR    — checkout of github.com/danielraffel/pulp-embed-juce
#
# Notes:
# - macOS-only today (pulp-embed-juce uses NSViewComponent).
# - pulp-embed-juce currently fetches its OWN JUCE 8.0.4 via FetchContent. We
#   rely on FetchContent_MakeAvailable being a no-op when JUCE targets already
#   exist in the build (because the parent project added JUCE first).
# - Their CMakeLists defaults PULP_EMBED_JUCE_BUILD_PLUGIN=ON which would
#   produce their demo PulpEmbedJucePlugin alongside our plugin — we force
#   that OFF so only the static `pulp_embed_juce` library target is built.

if(_YSS_PULP_INCLUDED)
    return()
endif()
set(_YSS_PULP_INCLUDED TRUE)

if(NOT APPLE)
    message(FATAL_ERROR
        "yssPulp: pulp-embed-juce is macOS-only today (NSViewComponent). "
        "Build with -DDDD_USE_PULP_UI=OFF on Windows.")
endif()

# ── Resolve paths ────────────────────────────────────────────────────────────
function(_yss_pulp_resolve var env_name default_path)
    if(DEFINED ${var} AND ${var})
        # Caller already set it on the command line — keep it.
    elseif(DEFINED ENV{${env_name}} AND NOT "$ENV{${env_name}}" STREQUAL "")
        set(${var} "$ENV{${env_name}}" PARENT_SCOPE)
    else()
        set(${var} "${default_path}" PARENT_SCOPE)
    endif()
endfunction()

_yss_pulp_resolve(PULP_SDK_INSTALL_DIR PULP_SDK_INSTALL_DIR
    "/Volumes/Areas/Development/SDK/Pulp/install")
_yss_pulp_resolve(PULP_VIEW_EMBED_DIR  PULP_VIEW_EMBED_DIR
    "/Volumes/Areas/Development/SDK/Pulp/pulp-view-embed")
_yss_pulp_resolve(PULP_EMBED_JUCE_DIR  PULP_EMBED_JUCE_DIR
    "/Volumes/Areas/Development/SDK/Pulp/pulp-embed-juce")

# ── Validate ─────────────────────────────────────────────────────────────────
if(NOT EXISTS "${PULP_SDK_INSTALL_DIR}/lib/cmake/Pulp")
    message(FATAL_ERROR
        "yssPulp: Pulp SDK install not found at ${PULP_SDK_INSTALL_DIR}.\n"
        "Build and install Pulp first:\n"
        "  cd /Volumes/Areas/Development/SDK/Pulp/pulp\n"
        "  ./setup.sh --ci\n"
        "  cmake --build build --target install --prefix ${PULP_SDK_INSTALL_DIR}\n"
        "Then re-configure DDIF, or set -DPULP_SDK_INSTALL_DIR=/elsewhere.")
endif()

if(NOT EXISTS "${PULP_VIEW_EMBED_DIR}/CMakeLists.txt")
    message(FATAL_ERROR
        "yssPulp: pulp-view-embed not found at ${PULP_VIEW_EMBED_DIR}.\n"
        "Clone it:\n"
        "  git clone https://github.com/danielraffel/pulp-view-embed.git ${PULP_VIEW_EMBED_DIR}\n"
        "Or set -DPULP_VIEW_EMBED_DIR=/elsewhere.")
endif()

if(NOT EXISTS "${PULP_EMBED_JUCE_DIR}/CMakeLists.txt")
    message(FATAL_ERROR
        "yssPulp: pulp-embed-juce not found at ${PULP_EMBED_JUCE_DIR}.\n"
        "Clone it:\n"
        "  git clone https://github.com/danielraffel/pulp-embed-juce.git ${PULP_EMBED_JUCE_DIR}\n"
        "Or set -DPULP_EMBED_JUCE_DIR=/elsewhere.")
endif()

# ── Make Pulp SDK discoverable to pulp-view-embed's find_package() ───────────
list(APPEND CMAKE_PREFIX_PATH "${PULP_SDK_INSTALL_DIR}")

# ── Suppress pulp-embed-juce's demo plugin target ────────────────────────────
# We only want the `pulp_embed_juce` static library, not their PulpEmbedJucePlugin.
set(PULP_EMBED_JUCE_BUILD_PLUGIN  OFF CACHE BOOL "Suppress pulp-embed-juce demo plugin" FORCE)
set(PULP_EMBED_JUCE_BUILD_EXAMPLE OFF CACHE BOOL "Suppress pulp-embed-juce demo app"    FORCE)
set(PULP_VIEW_EMBED_DIR "${PULP_VIEW_EMBED_DIR}" CACHE PATH "" FORCE)

# ── Pull in pulp-embed-juce ──────────────────────────────────────────────────
# It in turn add_subdirectory()s pulp-view-embed and FetchContent_MakeAvailable()s
# JUCE. The JUCE fetch is idempotent if the parent already added JUCE (the
# `juce::*` targets exist). pulp-view-embed's find_package(Pulp CONFIG) hits
# CMAKE_PREFIX_PATH we just appended.
message(STATUS "yssPulp: Pulp SDK install = ${PULP_SDK_INSTALL_DIR}")
message(STATUS "yssPulp: pulp-view-embed  = ${PULP_VIEW_EMBED_DIR}")
message(STATUS "yssPulp: pulp-embed-juce  = ${PULP_EMBED_JUCE_DIR}")
add_subdirectory("${PULP_EMBED_JUCE_DIR}" ${CMAKE_BINARY_DIR}/pulp-embed-juce-build)

# ── Public API ───────────────────────────────────────────────────────────────
function(yss_link_pulp target)
    if(NOT TARGET ${target})
        message(FATAL_ERROR "yss_link_pulp: target '${target}' does not exist")
    endif()
    target_link_libraries(${target} PRIVATE pulp_embed_juce)
    target_compile_definitions(${target} PRIVATE
        YSS_HAS_PULP_UI=1
        YSS_PULP_DEMO_BUNDLE="${PULP_VIEW_EMBED_DIR}/fixtures/figma-vst-style/bundle")
endfunction()
