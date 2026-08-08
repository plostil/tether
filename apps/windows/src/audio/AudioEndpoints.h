#pragma once
// Audio routing (SPEC §2.2, §4).
//
// Capture side (PC audio -> phone): WASAPI loopback on the render endpoint, or
// per-process loopback via ActivateAudioInterfaceAsync with
// AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK (Windows build 20348+). Note the
// documented quirk: in process-loopback mode GetMixFormat/IsFormatSupported
// return E_NOTIMPL, so the capture format must be hard-coded.
//
// Presentation side (phone audio -> other Windows apps as a mic/speaker):
// there is NO user-mode API to create an endpoint. We drive a LICENSED, SIGNED
// virtual audio driver (Thesycon TVirtAudio / open-source Virtual-Audio-Driver)
// through its user-mode control API. This class is only that control surface —
// it does not implement a driver.
//
// Invariant: audio routes by whole-device ownership. We never split mic and
// speaker across devices for a full-duplex call (distributed AEC diverges).

#include <cstdint>
#include <functional>

namespace tether::audio {

struct PcmChunk {
    const int16_t* samples;
    int frameCount;
    int channels;
    int sampleRate;
};

class LoopbackCapture {
public:
    using PcmCallback = std::function<void(const PcmChunk&)>;
    bool StartSystem(PcmCallback onPcm);
    bool StartProcess(uint32_t pid, bool includeTree, PcmCallback onPcm); // build 20348+
    void Stop();
};

// Thin control wrapper over the licensed signed virtual audio driver.
class VirtualDevice {
public:
    bool IsDriverInstalled() const;
    bool PresentAsSpeaker(); // phone audio played through this becomes selectable output
    bool PresentAsMicrophone(); // phone mic exposed to other apps as an input
    void PushPlayback(const PcmChunk& chunk);
};

} // namespace tether::audio
