package app.tether.pairing

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * Asserts the Kotlin Noise_IK port produces byte-identical output to the TS
 * reference, using the shared vectors in docs/noise-test-vectors.json (also
 * pinned by apps/server/test/noise-vectors.test.ts). If both pass, the two
 * implementations are wire-compatible.
 *
 * Runs on the JVM: `./gradlew :app:testDebugUnitTest`.
 */
class NoiseVectorsTest {

    private fun seed(b: Int) = ByteArray(32) { b.toByte() }
    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }
    private fun unhex(s: String) = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    // --- pinned vectors (must match docs/noise-test-vectors.json) ---
    private val initStaticPub = "a4e09292b651c278b9772c569f5fa9bb13d906b46ab68c9df9dc2b4409f8a209"
    private val respStaticPub = "ce8d3ad1ccb633ec7b70c17814a5c76ecd029685050d344745ba05870e587d59"
    private val initiatorDeviceId = "DKJPEOCS3SII3FZRNI5RGV4CQEMWYHOXHWNOLYYT6P5WXCKUX5KQ"
    private val responderDeviceId = "Z6SXBRSTXUQSWEFJZNKR7V5BWR4JQVPOC7UZ54VTUIBX72ZTPIEA"
    private val msg1Hex =
        "5dfedd3b6bd47f6fa28ee15d969d5bb0ea53774d488bdaf9df1c6e0124b3ef224391bcfef3f1b0f051873c2103356110f8056ef928c4354783347c74dc7b71b7fd9a860bc9013ff1aaeb4e5e0361f7a982719d50bb4b12f618593b7eb4429d1a545cbeb06b536abad62cd861"
    private val msg2Hex =
        "ac01b2209e86354fb853237b5de0f4fab13c7fcbf433a61c019369617fecf10bc49ef9949dee69058aed84e1c0ea497064d4c3ada285e59ea5919498"
    private val handshakeHashHex = "5115e4f1d7fb9eb9d6d41545a86146da961d88c02bb7a9148e327e91510971b1"
    private val tI2R = "66970412dcb4eb2a3a88c6c4ebd6e46746fdcc36b236618370"
    private val tR2I = "0ade26655b9fc47bca23570149f7901e492f7795c17e02136d"

    @Test
    fun matchesCrossLanguageVectors() {
        val initStatic = staticKeypairFromPrivate(seed(0x01))
        val respStatic = staticKeypairFromPrivate(seed(0x02))
        val initEph = staticKeypairFromPrivate(seed(0x03))
        val respEph = staticKeypairFromPrivate(seed(0x04))

        assertEquals(initStaticPub, hex(initStatic.publicKey))
        assertEquals(respStaticPub, hex(respStatic.publicKey))
        assertEquals(initiatorDeviceId, DeviceIdentity.deviceId(initStatic.publicKey))
        assertEquals(responderDeviceId, DeviceIdentity.deviceId(respStatic.publicKey))

        val initiator = NoiseHandshake.initiator(initStatic, respStatic.publicKey, initEph)
        val responder = NoiseHandshake.responder(respStatic, respEph)

        val msg1 = initiator.writeMessage("msg1-payload".toByteArray())
        assertEquals(msg1Hex, hex(msg1))
        assertEquals("msg1-payload", String(responder.readMessage(msg1)))

        val msg2 = responder.writeMessage("msg2-payload".toByteArray())
        assertEquals(msg2Hex, hex(msg2))
        assertEquals("msg2-payload", String(initiator.readMessage(msg2)))

        assertEquals(handshakeHashHex, hex(initiator.handshakeHash()))

        val it = initiator.split()
        val rt = responder.split()
        assertEquals(tI2R, hex(it.send.encryptWithAd(ByteArray(0), "phone->pc".toByteArray())))
        assertEquals(tR2I, hex(rt.send.encryptWithAd(ByteArray(0), "pc->phone".toByteArray())))

        // Cross-decrypt against the pinned ciphertext bytes (interop, not just self).
        assertEquals("phone->pc", String(rt.recv.decryptWithAd(ByteArray(0), unhex(tI2R))))
        assertEquals("pc->phone", String(it.recv.decryptWithAd(ByteArray(0), unhex(tR2I))))
    }

    @Test
    fun randomHandshakeRoundTripsAndVerifiesIdentity() {
        val initStatic = generateStaticKeypair()
        val respStatic = generateStaticKeypair()
        val initiator = NoiseHandshake.initiator(initStatic, respStatic.publicKey)
        val responder = NoiseHandshake.responder(respStatic)

        responder.readMessage(initiator.writeMessage())
        initiator.readMessage(responder.writeMessage())

        assertTrue(initiator.isComplete && responder.isComplete)
        assertTrue(respStatic.publicKey.contentEquals(initiator.remoteStaticKey))
        assertTrue(initStatic.publicKey.contentEquals(responder.remoteStaticKey))

        val it = initiator.split()
        val rt = responder.split()
        val ct = it.send.encryptWithAd(ByteArray(0), "hello".toByteArray())
        assertEquals("hello", String(rt.recv.decryptWithAd(ByteArray(0), ct)))
    }

    @Test
    fun tamperedMessageIsRejected() {
        val initStatic = generateStaticKeypair()
        val respStatic = generateStaticKeypair()
        val initiator = NoiseHandshake.initiator(initStatic, respStatic.publicKey)
        val responder = NoiseHandshake.responder(respStatic)

        val msg1 = initiator.writeMessage()
        msg1[msg1.size - 1] = (msg1[msg1.size - 1].toInt() xor 0xff).toByte()
        assertFailsWith<Exception> { responder.readMessage(msg1) }
    }
}
