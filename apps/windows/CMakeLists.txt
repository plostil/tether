cmake_minimum_required(VERSION 3.28)
project(tether_windows LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT WIN32)
    message(FATAL_ERROR "The Tether Windows client targets Windows only.")
endif()

# --- Dependencies (wire these up in your environment) ------------------------
# find_package(libwebrtc REQUIRED)   # transport + Opus + AEC3; external HW encoder
# WinRT (Windows.Graphics.Capture) comes via C++/WinRT + the Windows SDK.

# libsodium: X25519 + IETF ChaCha20-Poly1305 + SHA-256 for the Noise handshake.
#   vcpkg install libsodium   (then configure with the vcpkg toolchain file)
find_package(unofficial-sodium CONFIG REQUIRED)

# --- Crypto: Noise_IK handshake + device identity ----------------------------
# Byte-compatible with packages/protocol (TS) and the Kotlin port.
add_library(tether_crypto STATIC
    src/crypto/Noise.cpp
    src/crypto/Identity.cpp
)
target_include_directories(tether_crypto PUBLIC src)
target_link_libraries(tether_crypto PUBLIC unofficial-sodium::sodium)

# Standalone, independently buildable vector test — proves wire compatibility
# with the TS/Kotlin ports (docs/noise-test-vectors.json). Depends only on crypto.
#   cmake --build . --target tether_noise_test && ./tether_noise_test
add_executable(tether_noise_test test/noise_vectors_test.cpp)
target_link_libraries(tether_noise_test PRIVATE tether_crypto)
enable_testing()
add_test(NAME noise_vectors COMMAND tether_noise_test)

# --- Core: signaling, secure link, session coordinator -----------------------
add_library(tether_core STATIC
    src/signaling/SignalingClient.cpp
    src/link/SecureLink.cpp
    src/session/SessionCoordinator.cpp
)
target_include_directories(tether_core PUBLIC src)
target_link_libraries(tether_core PUBLIC tether_crypto)

# --- Screen capture (Windows.Graphics.Capture) -------------------------------
add_library(tether_capture STATIC src/capture/ScreenCapture.cpp)
target_link_libraries(tether_capture PRIVATE tether_core windowsapp)

# --- Audio (WASAPI loopback + virtual-device control) ------------------------
add_library(tether_audio STATIC src/audio/AudioEndpoints.cpp)
target_link_libraries(tether_audio PRIVATE tether_core)

# --- Input injection helper (MUST embed the uiAccess manifest) ---------------
add_executable(tether_input src/input/InputInjector.cpp)
target_link_libraries(tether_input PRIVATE tether_core)
# The uiAccess=true manifest is required for SendInput into elevated windows and
# must be Authenticode-signed + installed under %ProgramFiles% (SPEC §2.1).
set_target_properties(tether_input PROPERTIES
    LINK_FLAGS "/MANIFESTUAC:\"level='asInvoker' uiAccess='true'\"")

# --- SYSTEM service for secure-desktop input relay (UAC/lock screen) ----------
add_executable(tether_service src/service/SecureDesktopService.cpp)
target_link_libraries(tether_service PRIVATE tether_core)

# --- App shell / tray UI ------------------------------------------------------
add_executable(tether_app WIN32 src/app/main.cpp)
target_link_libraries(tether_app PRIVATE tether_core tether_capture tether_audio)
