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

# --- Core: signaling, Noise session, WebRTC transport, session coordinator ---
add_library(tether_core STATIC
    src/signaling/SignalingClient.cpp
    src/session/SessionCoordinator.cpp
)
target_include_directories(tether_core PUBLIC src)

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
