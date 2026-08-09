package app.tether.net

import app.tether.pairing.DeviceIdentity
import app.tether.pairing.NoiseHandshake
import app.tether.pairing.StaticKeypair
import app.tether.pairing.TransportPair
import kotlinx.coroutines.CompletableDeferred

/**
 * Client-side secure link — Kotlin port of apps/reference-cli/src/link.ts (SPEC §4).
 *
 * register → Noise_IK handshake over the broker's opaque relay → verify the
 * peer's authenticated static key fingerprints to the expected (scanned) device
 * id → encrypted transport. The broker never sees plaintext.
 *
 * Keep this behaviourally identical to the TS reference and the C++ port; the
 * shared vectors (docs/noise-test-vectors.json) pin the wire format.
 */
class SecureLink(
    serverUrl: String,
    private val staticKeypair: StaticKeypair,
    private val role: Role,
    private val peerStatic: ByteArray? = null,
    peerDeviceId: String? = null,
    private val onMessage: (ByteArray) -> Unit = {},
    private val logger: (String) -> Unit = {},
) : SignalingClient.Events {

    enum class Role { INITIATOR, RESPONDER }

    val deviceId: String = DeviceIdentity.deviceId(staticKeypair.publicKey)

    private val signaling = SignalingClient(serverUrl, deviceId, staticKeypair.publicKey, this)
    private var handshake: NoiseHandshake? = null
    private var transport: TransportPair? = null
    private var remoteId: String? = peerDeviceId

    private val registered = CompletableDeferred<Unit>()
    private val paired = CompletableDeferred<Unit>()

    /** Connect and register; suspends until the broker acknowledges. */
    suspend fun connect() {
        signaling.connect()
        registered.await()
    }

    /** Run the Noise_IK handshake; suspends until the transport is ready. */
    suspend fun pair() {
        when (role) {
            Role.INITIATOR -> {
                val ps = requireNotNull(peerStatic) { "initiator needs peerStatic (from the QR)" }
                remoteId = requireNotNull(remoteId) { "initiator needs peerDeviceId (from the QR)" }
                val hs = NoiseHandshake.initiator(staticKeypair, ps)
                handshake = hs
                logger("initiator: sending handshake msg1 -> ${short(remoteId!!)}")
                signaling.relay(remoteId!!, hs.writeMessage())
            }
            Role.RESPONDER -> {
                handshake = NoiseHandshake.responder(staticKeypair)
                logger("responder: waiting for handshake msg1…")
            }
        }
        paired.await()
    }

    fun send(message: ByteArray) {
        val t = checkNotNull(transport) { "not paired yet" }
        signaling.relay(remoteId!!, t.send.encryptWithAd(ByteArray(0), message))
    }

    fun send(message: String) = send(message.toByteArray())

    fun close() = signaling.close()

    // ---- SignalingClient.Events ----

    override fun onRegistered(heartbeatIntervalMs: Long) {
        logger("registered as ${short(deviceId)}")
        registered.complete(Unit)
    }

    override fun onPeerStatus(deviceId: String, online: Boolean) { /* presence UI hook */ }

    override fun onError(code: String, message: String) {
        val e = IllegalStateException("broker error: $code $message")
        if (!registered.isCompleted) registered.completeExceptionally(e)
        if (!paired.isCompleted) paired.completeExceptionally(e)
    }

    override fun onDeliver(from: String, payload: ByteArray) {
        // Transport phase: decrypt and surface to the caller.
        transport?.let {
            onMessage(it.recv.decryptWithAd(ByteArray(0), payload))
            return
        }

        // Handshake phase.
        val hs = handshake ?: return
        if (role == Role.RESPONDER && remoteId == null) {
            remoteId = from
            logger("responder: received msg1 from ${short(from)}")
        }

        try {
            hs.readMessage(payload)
            if (hs.isMyTurn) {
                logger("$role: replying with handshake msg2 -> ${short(remoteId!!)}")
                signaling.relay(remoteId!!, hs.writeMessage())
            }
            if (hs.isComplete) {
                val authenticatedId = DeviceIdentity.deviceId(hs.remoteStaticKey!!)
                if (authenticatedId != remoteId) {
                    paired.completeExceptionally(
                        IllegalStateException(
                            "identity mismatch: peer key fingerprints to ${short(authenticatedId)}, expected ${short(remoteId!!)}",
                        ),
                    )
                    return
                }
                transport = hs.split()
                logger("$role: handshake complete, peer verified as ${short(authenticatedId)}")
                paired.complete(Unit)
            }
        } catch (e: Exception) {
            if (!paired.isCompleted) paired.completeExceptionally(e)
        }
    }

    private fun short(id: String): String = id.take(8) + "…"
}
