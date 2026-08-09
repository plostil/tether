#include "Noise.h"

#include <cstring>
#include <sodium.h>

namespace tether::noise {

namespace {

constexpr int HASHLEN = 32;
constexpr int DHLEN = 32;
constexpr int TAGLEN = 16;
constexpr int BLAKE2S_BLOCK = 64;
const char* PROTOCOL_NAME = "Noise_IK_25519_ChaChaPoly_BLAKE2s";

void ensureSodium() {
    static const int rc = sodium_init(); // 0 or 1 (already initialised) are ok
    if (rc < 0) throw std::runtime_error("libsodium init failed");
}

Bytes concat(const Bytes& a, const Bytes& b) {
    Bytes out;
    out.reserve(a.size() + b.size());
    out.insert(out.end(), a.begin(), a.end());
    out.insert(out.end(), b.begin(), b.end());
    return out;
}

// ---- BLAKE2s (RFC 7693), unkeyed, 32-byte digest ----
inline uint32_t rotr32(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }

const uint32_t BLAKE2S_IV[8] = {
    0x6A09E667u, 0xBB67AE85u, 0x3C6EF372u, 0xA54FF53Au,
    0x510E527Fu, 0x9B05688Cu, 0x1F83D9ABu, 0x5BE0CD19u,
};

const uint8_t SIGMA[10][16] = {
    {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15},
    {14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3},
    {11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4},
    {7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8},
    {9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13},
    {2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9},
    {12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11},
    {13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10},
    {6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5},
    {10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0},
};

void blake2sCompress(uint32_t h[8], const uint8_t block[64], uint64_t t, bool last) {
    uint32_t m[16];
    for (int i = 0; i < 16; i++) {
        m[i] = static_cast<uint32_t>(block[i * 4]) | (static_cast<uint32_t>(block[i * 4 + 1]) << 8) |
               (static_cast<uint32_t>(block[i * 4 + 2]) << 16) |
               (static_cast<uint32_t>(block[i * 4 + 3]) << 24);
    }
    uint32_t v[16];
    for (int i = 0; i < 8; i++) v[i] = h[i];
    for (int i = 0; i < 8; i++) v[8 + i] = BLAKE2S_IV[i];
    v[12] ^= static_cast<uint32_t>(t & 0xFFFFFFFFu);
    v[13] ^= static_cast<uint32_t>(t >> 32);
    if (last) v[14] ^= 0xFFFFFFFFu;

    auto G = [&](int a, int b, int c, int d, uint32_t x, uint32_t y) {
        v[a] = v[a] + v[b] + x;
        v[d] = rotr32(v[d] ^ v[a], 16);
        v[c] = v[c] + v[d];
        v[b] = rotr32(v[b] ^ v[c], 12);
        v[a] = v[a] + v[b] + y;
        v[d] = rotr32(v[d] ^ v[a], 8);
        v[c] = v[c] + v[d];
        v[b] = rotr32(v[b] ^ v[c], 7);
    };

    for (int r = 0; r < 10; r++) {
        const uint8_t* s = SIGMA[r];
        G(0, 4, 8, 12, m[s[0]], m[s[1]]);
        G(1, 5, 9, 13, m[s[2]], m[s[3]]);
        G(2, 6, 10, 14, m[s[4]], m[s[5]]);
        G(3, 7, 11, 15, m[s[6]], m[s[7]]);
        G(0, 5, 10, 15, m[s[8]], m[s[9]]);
        G(1, 6, 11, 12, m[s[10]], m[s[11]]);
        G(2, 7, 8, 13, m[s[12]], m[s[13]]);
        G(3, 4, 9, 14, m[s[14]], m[s[15]]);
    }
    for (int i = 0; i < 8; i++) h[i] ^= v[i] ^ v[8 + i];
}

} // namespace

Bytes blake2s(const Bytes& in) {
    uint32_t h[8];
    for (int i = 0; i < 8; i++) h[i] = BLAKE2S_IV[i];
    h[0] ^= 0x01010000u ^ static_cast<uint32_t>(HASHLEN); // no key, 32-byte digest

    uint64_t t = 0;
    size_t inlen = in.size();
    const uint8_t* p = in.data();
    while (inlen > BLAKE2S_BLOCK) {
        t += BLAKE2S_BLOCK;
        blake2sCompress(h, p, t, false);
        p += BLAKE2S_BLOCK;
        inlen -= BLAKE2S_BLOCK;
    }
    uint8_t lastBlock[BLAKE2S_BLOCK] = {0};
    if (inlen) std::memcpy(lastBlock, p, inlen);
    t += inlen;
    blake2sCompress(h, lastBlock, t, true);

    Bytes out(32);
    for (int i = 0; i < 8; i++) {
        out[i * 4] = static_cast<uint8_t>(h[i]);
        out[i * 4 + 1] = static_cast<uint8_t>(h[i] >> 8);
        out[i * 4 + 2] = static_cast<uint8_t>(h[i] >> 16);
        out[i * 4 + 3] = static_cast<uint8_t>(h[i] >> 24);
    }
    return out;
}

Bytes hmacBlake2s(const Bytes& key, const Bytes& data) {
    Bytes k = key.size() > BLAKE2S_BLOCK ? blake2s(key) : key;
    k.resize(BLAKE2S_BLOCK, 0); // zero-pad to the block size
    Bytes ipad(BLAKE2S_BLOCK), opad(BLAKE2S_BLOCK);
    for (int i = 0; i < BLAKE2S_BLOCK; i++) {
        ipad[i] = k[i] ^ 0x36;
        opad[i] = k[i] ^ 0x5c;
    }
    Bytes inner = blake2s(concat(ipad, data));
    return blake2s(concat(opad, inner));
}

static std::vector<Bytes> hkdf(const Bytes& ck, const Bytes& ikm, int outputs) {
    Bytes tempKey = hmacBlake2s(ck, ikm);
    Bytes o1 = hmacBlake2s(tempKey, Bytes{0x01});
    Bytes o2in = o1;
    o2in.push_back(0x02);
    Bytes o2 = hmacBlake2s(tempKey, o2in);
    if (outputs == 2) return {o1, o2};
    Bytes o3in = o2;
    o3in.push_back(0x03);
    Bytes o3 = hmacBlake2s(tempKey, o3in);
    return {o1, o2, o3};
}

Bytes dh(const Bytes& priv, const Bytes& pub) {
    ensureSodium();
    Bytes out(crypto_scalarmult_BYTES);
    // Returns -1 for all-zero (small-order) output; not expected with valid keys.
    if (crypto_scalarmult(out.data(), priv.data(), pub.data()) != 0) {
        throw std::runtime_error("noise: X25519 produced a low-order (all-zero) result");
    }
    return out;
}

StaticKeypair staticKeypairFromPrivate(const Bytes& priv) {
    ensureSodium();
    Bytes pub(crypto_scalarmult_BYTES);
    (void)crypto_scalarmult_base(pub.data(), priv.data());
    return {priv, pub};
}

StaticKeypair generateStaticKeypair() {
    ensureSodium();
    Bytes priv(32);
    randombytes_buf(priv.data(), priv.size());
    return staticKeypairFromPrivate(priv);
}

// ---- CipherState ----

std::array<uint8_t, 12> CipherState::nonce() const {
    std::array<uint8_t, 12> nonce{};
    for (int i = 0; i < 8; i++) nonce[4 + i] = static_cast<uint8_t>(n_ >> (8 * i)); // LE counter
    return nonce;
}

void CipherState::initializeKey(const Bytes& key) {
    std::array<uint8_t, 32> k{};
    std::memcpy(k.data(), key.data(), 32);
    k_ = k;
    n_ = 0;
}

Bytes CipherState::encryptWithAd(const Bytes& ad, const Bytes& plaintext) {
    if (!k_) return plaintext;
    ensureSodium();
    auto nonce = this->nonce();
    Bytes out(plaintext.size() + TAGLEN);
    unsigned long long clen = 0;
    crypto_aead_chacha20poly1305_ietf_encrypt(
        out.data(), &clen, plaintext.data(), plaintext.size(),
        ad.data(), ad.size(), nullptr, nonce.data(), k_->data());
    out.resize(static_cast<size_t>(clen));
    n_++;
    return out;
}

Bytes CipherState::decryptWithAd(const Bytes& ad, const Bytes& ciphertext) {
    if (!k_) return ciphertext;
    ensureSodium();
    auto nonce = this->nonce();
    Bytes out(ciphertext.size() >= TAGLEN ? ciphertext.size() - TAGLEN : 0);
    unsigned long long mlen = 0;
    if (crypto_aead_chacha20poly1305_ietf_decrypt(
            out.data(), &mlen, nullptr, ciphertext.data(), ciphertext.size(),
            ad.data(), ad.size(), nonce.data(), k_->data()) != 0) {
        throw std::runtime_error("noise: AEAD authentication failed");
    }
    out.resize(static_cast<size_t>(mlen));
    n_++;
    return out;
}

// ---- NoiseHandshake ----

NoiseHandshake::NoiseHandshake(bool initiator, StaticKeypair s, Bytes rs,
                               std::optional<StaticKeypair> ephemeral, const Bytes& prologue)
    : initiator_(initiator), s_(std::move(s)), rs_(std::move(rs)),
      ephemeralOverride_(std::move(ephemeral)) {
    Bytes name(PROTOCOL_NAME, PROTOCOL_NAME + std::strlen(PROTOCOL_NAME));
    h_ = name.size() <= static_cast<size_t>(HASHLEN)
             ? [&] { Bytes b = name; b.resize(HASHLEN, 0); return b; }()
             : blake2s(name);
    ck_ = h_;
    mixHash(prologue);
    const Bytes& responderStatic = initiator_ ? rs_ : s_.publicKey;
    mixHash(responderStatic);
}

NoiseHandshake NoiseHandshake::initiator(const StaticKeypair& s, const Bytes& responderStatic,
                                         const std::optional<StaticKeypair>& ephemeral,
                                         const Bytes& prologue) {
    return NoiseHandshake(true, s, responderStatic, ephemeral, prologue);
}

NoiseHandshake NoiseHandshake::responder(const StaticKeypair& s,
                                         const std::optional<StaticKeypair>& ephemeral,
                                         const Bytes& prologue) {
    return NoiseHandshake(false, s, Bytes{}, ephemeral, prologue);
}

void NoiseHandshake::mixHash(const Bytes& data) { h_ = blake2s(concat(h_, data)); }

void NoiseHandshake::mixKey(const Bytes& ikm) {
    auto out = hkdf(ck_, ikm, 2);
    ck_ = out[0];
    symCipher_.initializeKey(out[1]);
}

Bytes NoiseHandshake::encryptAndHash(const Bytes& pt) {
    Bytes ct = symCipher_.encryptWithAd(h_, pt);
    mixHash(ct);
    return ct;
}

Bytes NoiseHandshake::decryptAndHash(const Bytes& ct) {
    Bytes pt = symCipher_.decryptWithAd(h_, ct);
    mixHash(ct);
    return pt;
}

bool NoiseHandshake::isComplete() const { return step_ >= 2; }

bool NoiseHandshake::isMyTurn() const {
    if (isComplete()) return false;
    bool writerIsInitiator = (step_ % 2 == 0);
    return writerIsInitiator == initiator_;
}

Bytes NoiseHandshake::handshakeHash() const { return h_; }

StaticKeypair NoiseHandshake::newEphemeral() const {
    return ephemeralOverride_ ? *ephemeralOverride_ : generateStaticKeypair();
}

// IK message patterns: {e, es, s, ss} then {e, ee, se}.
Bytes NoiseHandshake::writeMessage(const Bytes& payload) {
    if (!isMyTurn()) throw std::runtime_error("noise: not this party's turn to write");
    Bytes out;
    auto append = [&](const Bytes& b) { out.insert(out.end(), b.begin(), b.end()); };

    if (step_ == 0) { // e, es, s, ss
        e_ = newEphemeral();
        mixHash(e_->publicKey);
        append(e_->publicKey);
        mixKey(dh(e_->privateKey, rs_)); // es (initiator)
        append(encryptAndHash(s_.publicKey)); // s
        mixKey(dh(s_.privateKey, rs_)); // ss
    } else { // e, ee, se
        e_ = newEphemeral();
        mixHash(e_->publicKey);
        append(e_->publicKey);
        mixKey(dh(e_->privateKey, re_)); // ee
        mixKey(dh(e_->privateKey, rs_)); // se (responder: resp-ephemeral * init-static)
    }
    append(encryptAndHash(payload));
    step_++;
    return out;
}

Bytes NoiseHandshake::readMessage(const Bytes& message) {
    if (isMyTurn()) throw std::runtime_error("noise: not this party's turn to read");
    size_t off = 0;
    auto take = [&](size_t n) {
        Bytes b(message.begin() + off, message.begin() + off + n);
        off += n;
        return b;
    };

    if (step_ == 0) { // reader is the responder: e, es, s, ss
        re_ = take(DHLEN);
        mixHash(re_);
        mixKey(dh(s_.privateKey, re_)); // es (responder static * init ephemeral)
        size_t sLen = symCipher_.hasKey() ? DHLEN + TAGLEN : DHLEN;
        rs_ = decryptAndHash(take(sLen)); // s
        mixKey(dh(s_.privateKey, rs_)); // ss
    } else { // reader is the initiator: e, ee, se
        re_ = take(DHLEN);
        mixHash(re_);
        mixKey(dh(e_->privateKey, re_)); // ee
        mixKey(dh(s_.privateKey, re_)); // se (init static * resp ephemeral)
    }
    Bytes payload = decryptAndHash(Bytes(message.begin() + off, message.end()));
    step_++;
    return payload;
}

TransportPair NoiseHandshake::split() const {
    if (!isComplete()) throw std::runtime_error("noise: handshake not complete");
    auto out = hkdf(ck_, Bytes{}, 2);
    CipherState c1, c2;
    c1.initializeKey(out[0]);
    c2.initializeKey(out[1]);
    TransportPair tp;
    if (initiator_) {
        tp.send = c1;
        tp.recv = c2;
    } else {
        tp.send = c2;
        tp.recv = c1;
    }
    return tp;
}

} // namespace tether::noise
