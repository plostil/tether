package app.tether.pairing

import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.interfaces.XECPublicKey
import java.security.spec.NamedParameterSpec

/**
 * Device identity (SPEC §4). MUST produce byte-for-byte the same device ID as
 * packages/protocol/src/identity.ts: base32(SHA-256(raw 32-byte X25519 pubkey)),
 * RFC 4648 alphabet, no padding. The wire format is the cross-platform contract.
 *
 * Production note: persist the private key in the Android Keystore
 * (StrongBox-backed where available). This stub keeps it in memory.
 */
object DeviceIdentity {

    private const val BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

    fun generate(): KeyPair {
        val gen = KeyPairGenerator.getInstance("XDH")
        gen.initialize(NamedParameterSpec("X25519"))
        return gen.generateKeyPair()
    }

    /** Raw 32-byte little-endian X25519 public key (matches JWK "x"). */
    fun rawPublicKey(pub: XECPublicKey): ByteArray {
        // XECPublicKey.getU() is the little-endian u-coordinate as a BigInteger.
        val le = pub.u.toByteArray().reversedArray() // BigInteger is big-endian
        return ByteArray(32).also { out ->
            System.arraycopy(le, 0, out, 0, minOf(le.size, 32))
        }
    }

    fun deviceId(rawPublicKey: ByteArray): String {
        require(rawPublicKey.size == 32) { "X25519 public key must be 32 bytes" }
        val hash = MessageDigest.getInstance("SHA-256").digest(rawPublicKey)
        return base32(hash)
    }

    fun displayFingerprint(deviceId: String): String =
        deviceId.chunked(7).joinToString("-")

    private fun base32(bytes: ByteArray): String {
        val sb = StringBuilder()
        var bits = 0
        var value = 0
        for (b in bytes) {
            value = (value shl 8) or (b.toInt() and 0xff)
            bits += 8
            while (bits >= 5) {
                sb.append(BASE32[(value ushr (bits - 5)) and 31])
                bits -= 5
            }
        }
        if (bits > 0) sb.append(BASE32[(value shl (5 - bits)) and 31])
        return sb.toString()
    }
}
