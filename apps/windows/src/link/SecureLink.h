#pragma once
// Client-side secure link — C++ port of apps/reference-cli/src/link.ts (SPEC §4).
// register -> Noise_IK over the broker's opaque relay -> verify the peer's key
// fingerprints to the expected (scanned) device id -> encrypted transport.
//
// Behaviourally identical to the TS reference and Kotlin SecureLink. The
// transport is the SignalingClient (WebSocket to the broker); this class only
// owns the pairing state machine.

#include "../crypto/Noise.h"
#include "../signaling/SignalingClient.h"

#include <functional>
#include <future>
#include <memory>
#include <optional>
#include <string>

namespace tether::link {

using tether::noise::Bytes;
using tether::noise::StaticKeypair;

class SecureLink {
public:
    enum class Role { Initiator, Responder };

    struct Options {
        std::string serverUrl;
        StaticKeypair staticKeypair;
        Role role = Role::Responder;
        Bytes peerStatic;             // initiator: from the scanned QR
        std::string peerDeviceId;     // initiator: from the scanned QR
        std::function<void(const Bytes&)> onMessage;
        std::function<void(const std::string&)> logger;
    };

    explicit SecureLink(Options opts);

    const std::string& deviceId() const { return deviceId_; }

    std::future<void> connect(); // resolves on registration
    std::future<void> pair();    // resolves when the transport is ready
    void send(const Bytes& message);
    void close();

private:
    void onRegistered(int64_t heartbeatMs);
    void onDeliver(const std::string& from, const Bytes& payload);
    void onError(const std::string& code, const std::string& message);
    void log(const std::string& line);

    Options opts_;
    std::string deviceId_;
    std::string remoteId_;
    std::unique_ptr<tether::signaling::SignalingClient> signaling_;
    std::optional<tether::noise::NoiseHandshake> hs_;
    std::optional<tether::noise::TransportPair> transport_;

    std::promise<void> registered_;
    std::promise<void> paired_;
    bool registeredSettled_ = false;
    bool pairedSettled_ = false;
};

} // namespace tether::link
