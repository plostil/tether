#pragma once
// Client transport to the rendezvous/signaling broker (apps/server).
// Mirrors packages/protocol/src/messages.ts. Zero-trust: only opaque base64
// `payload` blobs (Noise handshake + ICE/SDP) cross this link (SPEC §4).

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace tether::signaling {

constexpr int kProtocolVersion = 1;

class SignalingClient {
public:
    struct Callbacks {
        std::function<void(int64_t heartbeatMs)> onRegistered;
        std::function<void(const std::string& from, const std::vector<uint8_t>& payload)> onDeliver;
        std::function<void(const std::string& deviceId, bool online)> onPeerStatus;
        std::function<void(const std::string& code, const std::string& message)> onError;
    };

    // deviceId MUST equal base32(SHA-256(rawPublicKey)) (SPEC §4).
    SignalingClient(std::string serverWsUrl,
                    std::string deviceId,
                    std::vector<uint8_t> rawPublicKey,
                    Callbacks callbacks);

    void Connect();
    void Close();
    void Relay(const std::string& to, const std::vector<uint8_t>& payload);
    void Watch(const std::string& peerDeviceId);

private:
    std::string serverWsUrl_;
    std::string deviceId_;
    std::vector<uint8_t> rawPublicKey_;
    Callbacks callbacks_;
};

} // namespace tether::signaling
