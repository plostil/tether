#include "Identity.h"

#include <sodium.h>
#include <stdexcept>

namespace tether::identity {

static const char* BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

std::string base32Encode(const std::vector<uint8_t>& bytes) {
    std::string out;
    int bits = 0;
    uint32_t value = 0;
    for (uint8_t b : bytes) {
        value = (value << 8) | b;
        bits += 8;
        while (bits >= 5) {
            out.push_back(BASE32[(value >> (bits - 5)) & 31]);
            bits -= 5;
        }
    }
    if (bits > 0) out.push_back(BASE32[(value << (5 - bits)) & 31]);
    return out;
}

std::string deviceIdFromPublicKey(const std::vector<uint8_t>& rawPublicKey) {
    if (rawPublicKey.size() != 32) throw std::runtime_error("X25519 public key must be 32 bytes");
    if (sodium_init() < 0) throw std::runtime_error("libsodium init failed");
    std::vector<uint8_t> hash(crypto_hash_sha256_BYTES);
    crypto_hash_sha256(hash.data(), rawPublicKey.data(), rawPublicKey.size());
    return base32Encode(hash);
}

std::string displayFingerprint(const std::string& deviceId) {
    std::string out;
    for (size_t i = 0; i < deviceId.size(); i += 7) {
        if (i) out.push_back('-');
        out += deviceId.substr(i, 7);
    }
    return out;
}

} // namespace tether::identity
