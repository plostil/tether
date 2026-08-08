package app.tether.audio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.projection.MediaProjection

/**
 * Capture OTHER apps' media/game audio and send it to the PC (SPEC §2.2).
 *
 * HARD PLATFORM LIMITS, encoded here so nobody assumes otherwise:
 *   - Requires a MediaProjection token -> inherits attended/screen-lock rules.
 *   - Only USAGE_MEDIA / USAGE_GAME / USAGE_UNKNOWN are capturable. VoIP audio
 *     (USAGE_VOICE_COMMUNICATION) is EXCLUDED by the platform: you cannot grab
 *     a WhatsApp/Teams call this way.
 *   - The playing app can opt out (ALLOW_CAPTURE_BY_NONE); most restrictive wins.
 *
 * There is NO stock path to present the PC's audio as a virtual mic/speaker to
 * other Android apps (that needs the priv-app COMPANION_DEVICE_APP_STREAMING
 * role). Audio therefore routes by whole-device ownership, never per-transducer.
 */
class MediaAudioCapture(private val projection: MediaProjection) {

    fun buildRecorder(): AudioRecord {
        val config = AudioPlaybackCaptureConfiguration.Builder(projection)
            .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
            .addMatchingUsage(AudioAttributes.USAGE_GAME)
            .build()

        val format = AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(48_000)
            .setChannelMask(AudioFormat.CHANNEL_IN_STEREO)
            .build()

        return AudioRecord.Builder()
            .setAudioFormat(format)
            .setAudioPlaybackCaptureConfig(config)
            .setBufferSizeInBytes(48_000 * 2 * 2 / 10) // ~100ms stereo 16-bit
            .build()
        // TODO: read PCM -> Opus 1.6.x encode -> WebRTC audio track (SPEC §4).
    }
}
