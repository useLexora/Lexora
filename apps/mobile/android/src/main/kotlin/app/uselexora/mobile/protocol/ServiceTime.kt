package app.uselexora.mobile.protocol

import java.time.Instant

class ServiceTime(private val anchor: Instant, private val requestStartedNanos: Long) {
    fun now(elapsedRealtimeNanos: Long): Instant {
        if (elapsedRealtimeNanos < requestStartedNanos) throw ProtocolFailure("REVIEW_REQUIRED")
        return anchor.plusNanos(elapsedRealtimeNanos - requestStartedNanos)
    }
}
