// Standalone test: the C++ Noise_IK port must produce byte-identical output to
// the TS and Kotlin ports, using the shared vectors in
// docs/noise-test-vectors.json (also pinned by the TS and Kotlin tests).
//
// Build just this (see apps/windows/CMakeLists.txt target tether_noise_test):
//   cmake --build . --target tether_noise_test && ./tether_noise_test

#include "../src/crypto/Noise.h"

#include <cstdio>
#include <string>

using tether::noise::Bytes;
using namespace tether::noise;

static int failures = 0;

static std::string toHex(const Bytes& b) {
    static const char* hexd = "0123456789abcdef";
    std::string s;
    s.reserve(b.size() * 2);
    for (uint8_t x : b) {
        s.push_back(hexd[x >> 4]);
        s.push_back(hexd[x & 0xf]);
    }
    return s;
}

static Bytes unhex(const std::string& s) {
    Bytes b(s.size() / 2);
    for (size_t i = 0; i < b.size(); i++) b[i] = static_cast<uint8_t>(std::stoi(s.substr(i * 2, 2), nullptr, 16));
    return b;
}

static Bytes seed(uint8_t v) { return Bytes(32, v); }
static Bytes str(const std::string& s) { return Bytes(s.begin(), s.end()); }

static void expectEq(const std::string& label, const std::string& got, const std::string& want) {
    if (got == want) {
        std::printf("  ok   %s\n", label.c_str());
    } else {
        std::printf("  FAIL %s\n       got  %s\n       want %s\n", label.c_str(), got.c_str(), want.c_str());
        failures++;
    }
}

// Pinned vectors — must match docs/noise-test-vectors.json.
namespace V {
const std::string initStaticPub = "a4e09292b651c278b9772c569f5fa9bb13d906b46ab68c9df9dc2b4409f8a209";
const std::string respStaticPub = "ce8d3ad1ccb633ec7b70c17814a5c76ecd029685050d344745ba05870e587d59";
const std::string msg1 =
    "5dfedd3b6bd47f6fa28ee15d969d5bb0ea53774d488bdaf9df1c6e0124b3ef224391bcfef3f1b0f051873c2103356110f8056ef928c4354783347c74dc7b71b7fd9a860bc9013ff1aaeb4e5e0361f7a982719d50bb4b12f618593b7eb4429d1a545cbeb06b536abad62cd861";
const std::string msg2 =
    "ac01b2209e86354fb853237b5de0f4fab13c7fcbf433a61c019369617fecf10bc49ef9949dee69058aed84e1c0ea497064d4c3ada285e59ea5919498";
const std::string handshakeHash = "5115e4f1d7fb9eb9d6d41545a86146da961d88c02bb7a9148e327e91510971b1";
const std::string tI2R = "66970412dcb4eb2a3a88c6c4ebd6e46746fdcc36b236618370";
const std::string tR2I = "0ade26655b9fc47bca23570149f7901e492f7795c17e02136d";
} // namespace V

int main() {
    std::printf("BLAKE2s known-answer tests:\n");
    expectEq("blake2s(\"\")", toHex(blake2s(str(""))),
             "69217a3079908094e11121d042354a7c1f55b6482ca1a51e1b250dfd1ed0eef9");
    expectEq("blake2s(\"abc\")", toHex(blake2s(str("abc"))),
             "508c5e8c327c14e2e1a72ba34eeb452f37458b209ed63a294d999b4c86675982");

    std::printf("Noise_IK cross-language vectors:\n");
    StaticKeypair initStatic = staticKeypairFromPrivate(seed(0x01));
    StaticKeypair respStatic = staticKeypairFromPrivate(seed(0x02));
    StaticKeypair initEph = staticKeypairFromPrivate(seed(0x03));
    StaticKeypair respEph = staticKeypairFromPrivate(seed(0x04));

    expectEq("initStaticPub", toHex(initStatic.publicKey), V::initStaticPub);
    expectEq("respStaticPub", toHex(respStatic.publicKey), V::respStaticPub);

    NoiseHandshake initiator = NoiseHandshake::initiator(initStatic, respStatic.publicKey, initEph);
    NoiseHandshake responder = NoiseHandshake::responder(respStatic, respEph);

    Bytes msg1 = initiator.writeMessage(str("msg1-payload"));
    expectEq("msg1", toHex(msg1), V::msg1);
    Bytes recv1 = responder.readMessage(msg1);
    expectEq("recv1", std::string(recv1.begin(), recv1.end()), "msg1-payload");

    Bytes msg2 = responder.writeMessage(str("msg2-payload"));
    expectEq("msg2", toHex(msg2), V::msg2);
    Bytes recv2 = initiator.readMessage(msg2);
    expectEq("recv2", std::string(recv2.begin(), recv2.end()), "msg2-payload");

    expectEq("handshakeHash", toHex(initiator.handshakeHash()), V::handshakeHash);

    TransportPair it = initiator.split();
    TransportPair rt = responder.split();
    expectEq("transport i->r", toHex(it.send.encryptWithAd({}, str("phone->pc"))), V::tI2R);
    expectEq("transport r->i", toHex(rt.send.encryptWithAd({}, str("pc->phone"))), V::tR2I);

    // Cross-decrypt the pinned ciphertext bytes (interop, not just self-round-trip).
    Bytes d1 = rt.recv.decryptWithAd({}, unhex(V::tI2R));
    expectEq("decrypt pinned i->r", std::string(d1.begin(), d1.end()), "phone->pc");
    Bytes d2 = it.recv.decryptWithAd({}, unhex(V::tR2I));
    expectEq("decrypt pinned r->i", std::string(d2.begin(), d2.end()), "pc->phone");

    std::printf("\n%s\n", failures == 0 ? "ALL PASSED" : "FAILURES PRESENT");
    return failures == 0 ? 0 : 1;
}
