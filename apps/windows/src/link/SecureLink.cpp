#include "SecureLink.h"

#include "../crypto/Identity.h"

namespace tether::link {

static std::string shortId(const std::string& id) { return id.substr(0, 8) + "..."; }

SecureLink::SecureLink(Options opts) : opts_(std::move(opts)) {
    deviceId_ = tether::identity::deviceIdFromPublicKey(opts_.staticKeypair.publicKey);
    remoteId_ = opts_.peerDeviceId;

    tether::signaling::SignalingClient::Callbacks cbs;
    cbs.onRegistered = [this](int64_t hb) { onRegistered(hb); };
    cbs.onDeliver = [this](const std::string& from, const Bytes& payload) { onDeliver(from, payload); };
    cbs.onPeerStatus = [](const std::string&, bool) {};
    cbs.onError = [this](const std::string& code, const std::string& msg) { onError(code, msg); };

    signaling_ = std::make_unique<tether::signaling::SignalingClient>(
        opts_.serverUrl, deviceId_, opts_.staticKeypair.publicKey, std::move(cbs));
}

void SecureLink::log(const std::string& line) {
    if (opts_.logger) opts_.logger(line);
}

std::future<void> SecureLink::connect() {
    auto fut = registered_.get_future();
    signaling_->Connect();
    return fut;
}

std::future<void> SecureLink::pair() {
    auto fut = paired_.get_future();
    if (opts_.role == Role::Initiator) {
        if (opts_.peerStatic.empty() || remoteId_.empty()) {
            throw std::runtime_error("initiator needs peerStatic + peerDeviceId (from the QR)");
        }
        hs_ = tether::noise::NoiseHandshake::initiator(opts_.staticKeypair, opts_.peerStatic);
        log("initiator: sending handshake msg1 -> " + shortId(remoteId_));
        signaling_->Relay(remoteId_, hs_->writeMessage());
    } else {
        hs_ = tether::noise::NoiseHandshake::responder(opts_.staticKeypair);
        log("responder: waiting for handshake msg1...");
    }
    return fut;
}

void SecureLink::send(const Bytes& message) {
    if (!transport_) throw std::runtime_error("not paired yet");
    signaling_->Relay(remoteId_, transport_->send.encryptWithAd({}, message));
}

void SecureLink::close() { signaling_->Close(); }

void SecureLink::onRegistered(int64_t) {
    log("registered as " + shortId(deviceId_));
    if (!registeredSettled_) {
        registeredSettled_ = true;
        registered_.set_value();
    }
}

void SecureLink::onError(const std::string& code, const std::string& message) {
    auto e = std::make_exception_ptr(std::runtime_error("broker error: " + code + " " + message));
    if (!registeredSettled_) {
        registeredSettled_ = true;
        registered_.set_exception(e);
    }
    if (!pairedSettled_) {
        pairedSettled_ = true;
        paired_.set_exception(e);
    }
}

void SecureLink::onDeliver(const std::string& from, const Bytes& payload) {
    // Transport phase.
    if (transport_) {
        if (opts_.onMessage) opts_.onMessage(transport_->recv.decryptWithAd({}, payload));
        return;
    }

    // Handshake phase.
    if (!hs_) return;
    if (opts_.role == Role::Responder && remoteId_.empty()) {
        remoteId_ = from;
        log("responder: received msg1 from " + shortId(from));
    }

    try {
        hs_->readMessage(payload);
        if (hs_->isMyTurn()) {
            log("replying with handshake msg2 -> " + shortId(remoteId_));
            signaling_->Relay(remoteId_, hs_->writeMessage());
        }
        if (hs_->isComplete()) {
            std::string authenticatedId = tether::identity::deviceIdFromPublicKey(hs_->remoteStaticKey());
            if (authenticatedId != remoteId_) {
                if (!pairedSettled_) {
                    pairedSettled_ = true;
                    paired_.set_exception(std::make_exception_ptr(std::runtime_error(
                        "identity mismatch: peer key fingerprints to " + shortId(authenticatedId) +
                        ", expected " + shortId(remoteId_))));
                }
                return;
            }
            transport_ = hs_->split();
            log("handshake complete, peer verified as " + shortId(authenticatedId));
            if (!pairedSettled_) {
                pairedSettled_ = true;
                paired_.set_value();
            }
        }
    } catch (...) {
        if (!pairedSettled_) {
            pairedSettled_ = true;
            paired_.set_exception(std::current_exception());
        }
    }
}

} // namespace tether::link
