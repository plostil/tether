package app.tether.net

import android.util.Base64
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

/**
 * Client transport to the rendezvous/signaling broker (apps/server).
 *
 * Mirrors packages/protocol/src/messages.ts. The broker is zero-trust: we only
 * ever send it opaque base64 `payload` blobs (Noise handshake + ICE/SDP), never
 * plaintext session content. Everything sensitive is inside the Noise session
 * established end-to-end with the peer (SPEC §4).
 */
class SignalingClient(
    private val serverUrl: String, // ws://host:8080/signal
    private val deviceId: String,
    private val rawPublicKey: ByteArray,
    private val listener: Events,
) : WebSocketListener() {

    interface Events {
        fun onRegistered(heartbeatIntervalMs: Long)
        /** An opaque blob relayed from `from` — hand to the Noise/session layer. */
        fun onDeliver(from: String, payload: ByteArray)
        fun onPeerStatus(deviceId: String, online: Boolean)
        fun onError(code: String, message: String)
    }

    private val http = OkHttpClient()
    private var ws: WebSocket? = null

    fun connect() {
        ws = http.newWebSocket(Request.Builder().url(serverUrl).build(), this)
    }

    fun close() {
        ws?.close(1000, null)
        ws = null
    }

    /** Send an opaque blob to a peer by device ID. */
    fun relay(to: String, payload: ByteArray) {
        val msg = JSONObject()
            .put("t", "relay")
            .put("to", to)
            .put("payload", Base64.encodeToString(payload, Base64.NO_WRAP))
        ws?.send(msg.toString())
    }

    fun watch(peerDeviceId: String) {
        ws?.send(JSONObject().put("t", "watch").put("deviceId", peerDeviceId).toString())
    }

    override fun onOpen(webSocket: WebSocket, response: Response) {
        val register = JSONObject()
            .put("t", "register")
            .put("protocolVersion", PROTOCOL_VERSION)
            .put("deviceId", deviceId)
            .put("publicKey", Base64.encodeToString(rawPublicKey, Base64.NO_WRAP))
            .put("capabilities", JSONObject()) // TODO: emit real DeviceCapabilities
        webSocket.send(register.toString())
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
        val m = JSONObject(text)
        when (m.getString("t")) {
            "registered" -> listener.onRegistered(m.optLong("heartbeatIntervalMs", 20_000))
            "deliver" -> listener.onDeliver(
                m.getString("from"),
                Base64.decode(m.getString("payload"), Base64.NO_WRAP),
            )
            "peer-status" -> listener.onPeerStatus(m.getString("deviceId"), m.getBoolean("online"))
            "error" -> listener.onError(m.getString("code"), m.optString("message"))
        }
    }

    companion object {
        const val PROTOCOL_VERSION = 1
    }
}
