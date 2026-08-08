#pragma once
// PC screen -> phone (SPEC §2.1, §4).
//
// Uses Windows.Graphics.Capture (WinRT). Construct a GraphicsCaptureItem from an
// HMONITOR (whole display) or HWND (single window) via IGraphicsCaptureItemInterop.
// Frame pool format DXGI_FORMAT_R16G16B16A16_FLOAT for HDR; tone-map HDR->SDR on
// this side before encode unless the phone is confirmed HDR-capable. Use each
// frame's SystemRelativeTime (QPC) as the A/V-sync timestamp.
//
// Borderless (no yellow capture indicator) requires an MSIX-packaged app with the
// restricted graphicsCaptureWithoutBorder capability + GraphicsCaptureAccess.
// Rejected: DXGI Desktop Duplication (no per-window, hybrid-GPU issues).

#include <cstdint>
#include <functional>

namespace tether::capture {

struct Frame {
    const uint8_t* data;
    int width;
    int height;
    int stride;
    int64_t timestampQpc; // SystemRelativeTime
};

class ScreenCapture {
public:
    using FrameCallback = std::function<void(const Frame&)>;

    // targetWindow == nullptr -> capture the primary monitor.
    bool StartMonitor(void* hmonitor, FrameCallback onFrame);
    bool StartWindow(void* hwnd, FrameCallback onFrame);
    void Stop();

    // false unless running MSIX-packaged with the borderless capability.
    void SetBorderRequired(bool required);
};

} // namespace tether::capture
