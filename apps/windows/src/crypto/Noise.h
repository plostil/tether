#pragma once
// Noise_IK_25519_ChaChaPoly_BLAKE2s — C++ port of packages/protocol/src/noise.ts
// (SPEC §4). MUST stay byte-identical to the TS and Kotlin ports; the shared
// vectors in docs/noise-test-vectors.json are asserted by all three
// (see test/noise_vectors_test.cpp).
//
// Crypto: libsodium for X25519 (crypto_scalarmult) and IETF ChaCha20-Poly1305;
// a self-contained BLAKE2s (the one primitive libsodium does not expose) with a
// hand-rolled HMAC. A device's static keypair is its identity keypair.

#include <array>
#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

namespace tether::noise {

using Bytes = std::vector<uint8_t>;

struct StaticKeypair {
    Bytes privateKey; // 32 bytes
    Bytes publicKey;  // 32 bytes
};

// --- primitives (exposed for testing) ---
Bytes blake2s(const Bytes& in);                       // 32-byte digest
Bytes hmacBlake2s(const Bytes& key, const Bytes& data);
Bytes dh(const Bytes& priv, const Bytes& pub);        // X25519
StaticKeypair generateStaticKeypair();
StaticKeypair staticKeypairFromPrivate(const Bytes& priv);

class CipherState {
public:
    void initializeKey(const Bytes& key);
    bool hasKey() const { return k_.has_value(); }
    Bytes encryptWithAd(const Bytes& ad, const Bytes& plaintext);
    Bytes decryptWithAd(const Bytes& ad, const Bytes& ciphertext); // throws on auth failure

private:
    std::optional<std::array<uint8_t, 32>> k_;
    uint64_t n_ = 0;
    std::array<uint8_t, 12> nonce() const;
};

struct TransportPair {
    CipherState send;
    CipherState recv;
};

class NoiseHandshake {
public:
    static NoiseHandshake initiator(const StaticKeypair& s, const Bytes& responderStatic,
                                    const std::optional<StaticKeypair>& ephemeral = std::nullopt,
                                    const Bytes& prologue = {});
    static NoiseHandshake responder(const StaticKeypair& s,
                                    const std::optional<StaticKeypair>& ephemeral = std::nullopt,
                                    const Bytes& prologue = {});

    bool isComplete() const;
    bool isMyTurn() const;
    Bytes writeMessage(const Bytes& payload = {});
    Bytes readMessage(const Bytes& message);
    const Bytes& remoteStaticKey() const { return rs_; }
    Bytes handshakeHash() const;
    TransportPair split() const;

private:
    NoiseHandshake(bool initiator, StaticKeypair s, Bytes rs,
                   std::optional<StaticKeypair> ephemeral, const Bytes& prologue);

    // SymmetricState, inlined into the handshake for brevity.
    Bytes ck_;
    Bytes h_;
    CipherState symCipher_;
    void mixHash(const Bytes& data);
    void mixKey(const Bytes& ikm);
    Bytes encryptAndHash(const Bytes& pt);
    Bytes decryptAndHash(const Bytes& ct);

    bool initiator_;
    StaticKeypair s_;
    Bytes rs_;                        // remote static
    std::optional<StaticKeypair> e_;  // local ephemeral
    Bytes re_;                        // remote ephemeral
    std::optional<StaticKeypair> ephemeralOverride_;
    int step_ = 0;

    StaticKeypair newEphemeral() const;
};

} // namespace tether::noise
