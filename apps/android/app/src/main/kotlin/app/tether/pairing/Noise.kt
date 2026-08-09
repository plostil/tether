package app.tether.pairing

import org.bouncycastle.crypto.digests.Blake2sDigest
import org.bouncycastle.crypto.macs.HMac
import org.bouncycastle.crypto.params.KeyParameter
import org.bouncycastle.math.ec.rfc7748.X25519
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Noise_IK_25519_ChaChaPoly_BLAKE2s — Kotlin port of packages/protocol/src/noise.ts
 * (SPEC §4). MUST stay byte-identical to the TS reference; the shared vectors in
 * docs/noise-test-vectors.json are asserted by both sides (see NoiseVectorsTest).
 *
 * Crypto: BouncyCastle for X25519 (RFC 7748) and BLAKE2s/HMAC; the JDK for
 * ChaCha20-Poly1305 (JDK 11+). A device's static keypair is its identity keypair
 * — its public key fingerprints to the device id (see DeviceIdentity).
 */

private const val HASHLEN = 32
private const val DHLEN = 32
private const val TAGLEN = 16
private const val PROTOCOL_NAME = "Noise_IK_25519_ChaChaPoly_BLAKE2s"

data class StaticKeypair(val privateKey: ByteArray, val publicKey: ByteArray)

class TransportPair(val send: CipherState, val recv: CipherState)

// ---- primitives -------------------------------------------------------------

private fun blake2s(data: ByteArray): ByteArray {
    val d = Blake2sDigest(256)
    d.update(data, 0, data.size)
    val out = ByteArray(32)
    d.doFinal(out, 0)
    return out
}

private fun hmac(key: ByteArray, data: ByteArray): ByteArray {
    val m = HMac(Blake2sDigest(256))
    m.init(KeyParameter(key))
    m.update(data, 0, data.size)
    val out = ByteArray(m.macSize)
    m.doFinal(out, 0)
    return out
}

/** Noise HKDF: derive 2 or 3 keys from a chaining key + input material. */
private fun hkdf(chainingKey: ByteArray, ikm: ByteArray, outputs: Int): List<ByteArray> {
    val tempKey = hmac(chainingKey, ikm)
    val o1 = hmac(tempKey, byteArrayOf(0x01))
    val o2 = hmac(tempKey, o1 + byteArrayOf(0x02))
    if (outputs == 2) return listOf(o1, o2)
    val o3 = hmac(tempKey, o2 + byteArrayOf(0x03))
    return listOf(o1, o2, o3)
}

private fun dh(priv: ByteArray, pub: ByteArray): ByteArray {
    val out = ByteArray(32)
    X25519.scalarMult(priv, 0, pub, 0, out, 0)
    return out
}

fun generateStaticKeypair(): StaticKeypair {
    val priv = ByteArray(32)
    SecureRandom().nextBytes(priv)
    return staticKeypairFromPrivate(priv)
}

fun staticKeypairFromPrivate(priv: ByteArray): StaticKeypair {
    val pub = ByteArray(32)
    X25519.scalarMultBase(priv, 0, pub, 0)
    return StaticKeypair(priv.copyOf(), pub)
}

// ---- CipherState ------------------------------------------------------------

class CipherState {
    private var k: ByteArray? = null
    private var n: Long = 0

    fun initializeKey(key: ByteArray?) {
        k = key
        n = 0
    }

    fun hasKey(): Boolean = k != null

    private fun nonce(): ByteArray {
        val nonce = ByteArray(12)
        ByteBuffer.wrap(nonce).order(ByteOrder.LITTLE_ENDIAN).putLong(4, n) // 4 zero bytes || LE counter
        return nonce
    }

    fun encryptWithAd(ad: ByteArray, plaintext: ByteArray): ByteArray {
        val key = k ?: return plaintext.copyOf()
        val cipher = Cipher.getInstance("ChaCha20-Poly1305")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "ChaCha20"), IvParameterSpec(nonce()))
        cipher.updateAAD(ad)
        val out = cipher.doFinal(plaintext) // JDK appends the 16-byte tag
        n++
        return out
    }

    fun decryptWithAd(ad: ByteArray, ciphertext: ByteArray): ByteArray {
        val key = k ?: return ciphertext.copyOf()
        val cipher = Cipher.getInstance("ChaCha20-Poly1305")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "ChaCha20"), IvParameterSpec(nonce()))
        cipher.updateAAD(ad)
        val out = cipher.doFinal(ciphertext) // throws AEADBadTagException on auth failure
        n++
        return out
    }
}

// ---- SymmetricState ---------------------------------------------------------

private class SymmetricState {
    private var ck: ByteArray
    private var h: ByteArray
    val cipher = CipherState()

    init {
        val name = PROTOCOL_NAME.toByteArray(Charsets.UTF_8)
        h = if (name.size <= HASHLEN) name.copyOf(HASHLEN) else blake2s(name)
        ck = h.copyOf()
    }

    fun handshakeHash(): ByteArray = h

    fun mixHash(data: ByteArray) {
        h = blake2s(h + data)
    }

    fun mixKey(ikm: ByteArray) {
        val out = hkdf(ck, ikm, 2)
        ck = out[0]
        cipher.initializeKey(out[1])
    }

    fun encryptAndHash(plaintext: ByteArray): ByteArray {
        val ct = cipher.encryptWithAd(h, plaintext)
        mixHash(ct)
        return ct
    }

    fun decryptAndHash(ciphertext: ByteArray): ByteArray {
        val pt = cipher.decryptWithAd(h, ciphertext)
        mixHash(ciphertext)
        return pt
    }

    fun split(): Pair<CipherState, CipherState> {
        val out = hkdf(ck, ByteArray(0), 2)
        val c1 = CipherState()
        val c2 = CipherState()
        c1.initializeKey(out[0])
        c2.initializeKey(out[1])
        return Pair(c1, c2)
    }
}

// ---- HandshakeState (IK) ----------------------------------------------------

class NoiseHandshake private constructor(
    private val initiator: Boolean,
    private val s: StaticKeypair,
    private var rs: ByteArray?,
    private val ephemeralOverride: StaticKeypair?,
    prologue: ByteArray,
) {
    private val ss = SymmetricState()
    private var e: StaticKeypair? = null
    private var re: ByteArray? = null
    private var step = 0

    init {
        ss.mixHash(prologue)
        // IK pre-message "<- s": the responder's static public key is known to both.
        val responderStatic = if (initiator) rs!! else s.publicKey
        ss.mixHash(responderStatic)
    }

    val isComplete: Boolean get() = step >= IK_MESSAGES.size

    val remoteStaticKey: ByteArray? get() = rs

    val isMyTurn: Boolean
        get() {
            if (isComplete) return false
            val writerIsInitiator = step % 2 == 0
            return writerIsInitiator == initiator
        }

    fun handshakeHash(): ByteArray = ss.handshakeHash()

    private fun newEphemeral(): StaticKeypair = ephemeralOverride ?: generateStaticKeypair()

    fun writeMessage(payload: ByteArray = ByteArray(0)): ByteArray {
        require(isMyTurn) { "noise: not this party's turn to write" }
        val out = ByteArrayOutputStream()
        for (token in IK_MESSAGES[step]) {
            when (token) {
                "e" -> {
                    e = newEphemeral()
                    ss.mixHash(e!!.publicKey)
                    out.write(e!!.publicKey)
                }
                "s" -> out.write(ss.encryptAndHash(s.publicKey))
                "ee" -> ss.mixKey(dh(e!!.privateKey, re!!))
                "es" -> ss.mixKey(if (initiator) dh(e!!.privateKey, rs!!) else dh(s.privateKey, re!!))
                "se" -> ss.mixKey(if (initiator) dh(s.privateKey, re!!) else dh(e!!.privateKey, rs!!))
                "ss" -> ss.mixKey(dh(s.privateKey, rs!!))
            }
        }
        out.write(ss.encryptAndHash(payload))
        step++
        return out.toByteArray()
    }

    fun readMessage(message: ByteArray): ByteArray {
        require(!isMyTurn) { "noise: not this party's turn to read" }
        var buf = message
        for (token in IK_MESSAGES[step]) {
            when (token) {
                "e" -> {
                    re = buf.copyOfRange(0, DHLEN)
                    ss.mixHash(re!!)
                    buf = buf.copyOfRange(DHLEN, buf.size)
                }
                "s" -> {
                    val len = if (ss.cipher.hasKey()) DHLEN + TAGLEN else DHLEN
                    rs = ss.decryptAndHash(buf.copyOfRange(0, len))
                    buf = buf.copyOfRange(len, buf.size)
                }
                "ee" -> ss.mixKey(dh(e!!.privateKey, re!!))
                "es" -> ss.mixKey(if (initiator) dh(e!!.privateKey, rs!!) else dh(s.privateKey, re!!))
                "se" -> ss.mixKey(if (initiator) dh(s.privateKey, re!!) else dh(e!!.privateKey, rs!!))
                "ss" -> ss.mixKey(dh(s.privateKey, rs!!))
            }
        }
        val payload = ss.decryptAndHash(buf)
        step++
        return payload
    }

    /** After completion, derive transport ciphers with role-correct send/recv. */
    fun split(): TransportPair {
        check(isComplete) { "noise: handshake not complete" }
        val (c1, c2) = ss.split()
        return if (initiator) TransportPair(c1, c2) else TransportPair(c2, c1)
    }

    companion object {
        private val IK_MESSAGES = listOf(
            listOf("e", "es", "s", "ss"), // initiator -> responder
            listOf("e", "ee", "se"),      // responder -> initiator
        )

        fun initiator(
            s: StaticKeypair,
            responderStatic: ByteArray,
            ephemeral: StaticKeypair? = null,
            prologue: ByteArray = ByteArray(0),
        ): NoiseHandshake = NoiseHandshake(true, s, responderStatic, ephemeral, prologue)

        fun responder(
            s: StaticKeypair,
            ephemeral: StaticKeypair? = null,
            prologue: ByteArray = ByteArray(0),
        ): NoiseHandshake = NoiseHandshake(false, s, null, ephemeral, prologue)
    }
}
