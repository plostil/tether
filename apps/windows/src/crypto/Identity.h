#pragma once
// Device identity (SPEC §4): deviceId = base32(SHA-256(raw X25519 public key)),
// RFC 4648 alphabet, no padding. MUST match packages/protocol/src/identity.ts
// and the Kotlin DeviceIdentity.

#include <cstdint>
#include <string>
#include <vector>

namespace tether::identity {

std::string base32Encode(const std::vector<uint8_t>& bytes);
std::string deviceIdFromPublicKey(const std::vector<uint8_t>& rawPublicKey); // 32-byte key
std::string displayFingerprint(const std::string& deviceId);

} // namespace tether::identity
