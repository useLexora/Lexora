package app.uselexora.mobile.session

import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.R
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.os.Handler
import app.uselexora.mobile.network.MobileConnection
import app.uselexora.mobile.network.ProductClient
import app.uselexora.mobile.protocol.ProductIdentity
import app.uselexora.mobile.protocol.ProductResumePoint
import app.uselexora.mobile.protocol.SubscriptionProjection
import app.uselexora.mobile.protocol.ProductSubscription
import app.uselexora.mobile.protocol.ProtocolFailure
import app.uselexora.mobile.protocol.ProtocolSchemas
import org.json.JSONObject
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

enum class MobileConnectionPhase { Idle, Connecting, Retrying, Unavailable }

class MobileConnectionSession(
    private val connection: MobileConnection,
    private val schemas: ProtocolSchemas,
    private val connectivity: ConnectivityManager,
    private val handler: Handler,
    private val enabled: () -> Boolean,
    private val topic: () -> String,
    private val work: (() -> Unit) -> Unit,
    private val onUi: (() -> Unit) -> Unit,
    private val released: () -> Unit,
    private val connected: (ProductClient, ProductIdentity) -> Unit,
    private val status: (String, MobileConnectionPhase) -> Unit,
    private val failureMessage: (Exception) -> String,
    private val synchronization: (String) -> Unit,
    private val projection: (String, List<JSONObject>, Long) -> Unit,
    private val recoverable: (Exception) -> Boolean,
    private val synchronizationFailure: (Exception) -> Unit = {},
) {
    @Volatile var client: ProductClient? = null
        private set
    var subscription: ProductSubscription? = null
        private set
    val isSynchronized: Boolean get() = client?.isConnected == true && subscription?.isSynchronized == true
    @Volatile var generation = 0L
        private set
    @Volatile var foreground = false
        private set
    var reconnectAllowed = true
    @Volatile private var connecting = false
    @Volatile private var closed = false
    private var reconnectRequested = false
    private var reconnectAttempts = 0
    private var observing = false
    private var observedNetwork: Network? = null
    private val retry = Runnable { requestReconnect() }
    private val snapshotSerials = AtomicLong()
    private var backgroundPoint: ProductResumePoint? = null
    private data class Update(val client: ProductClient, val generation: Long, val topic: String, val items: List<JSONObject>, val snapshotSerial: Long)
    private val pending = AtomicReference<Update?>()
    private val scheduled = AtomicBoolean(false)
    private val flushProjection = Runnable {
        scheduled.set(false)
        val update = pending.getAndSet(null)
        if (!closed && update != null && client === update.client && generation == update.generation && topic() == update.topic)
            projection(update.topic, update.items, update.snapshotSerial)
    }
    private val networkChanges = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) { observedNetwork = network; requestReconnect() }
        override fun onLost(network: Network) {
            if (observedNetwork != network) return
            observedNetwork = null
            if (foreground && reconnectAllowed) { client?.close(); requestReconnect() }
        }
        override fun onLinkPropertiesChanged(network: Network, properties: LinkProperties) { requestReconnect() }
    }

    fun start(observeNetwork: Boolean = true) {
        foreground = true
        if (!observeNetwork || closed) return
        if (!observing) { connectivity.registerDefaultNetworkCallback(networkChanges, handler); observing = true }
        requestReconnect()
    }
    fun stop() {
        foreground = false
        handler.removeCallbacks(retry)
        reconnectRequested = false
        if (observing) { connectivity.unregisterNetworkCallback(networkChanges); observing = false }
        val point = if (closed) null else backgroundPoint ?: subscription?.checkpoint?.copy(recordedAt = System.nanoTime())
        invalidate()
        backgroundPoint = point
        if (enabled() && reconnectAllowed) status(mobileText(if (connection.hasSavedIdentity()) R.string.connection_disconnected else R.string.connection_not_connected), MobileConnectionPhase.Idle)
    }
    fun invalidate(): Long {
        backgroundPoint = null
        generation++
        releaseConnection()
        pending.set(null)
        return generation
    }
    private fun releaseConnection() {
        released()
        subscription?.close(); subscription = null
        client?.close(); client = null
    }
    fun disconnect() { reconnectAllowed = false; reconnectRequested = false; invalidate() }
    fun resume() { reconnectAllowed = true; connectSaved() }
    fun requestReconnect() {
        if (!foreground || !enabled() || !reconnectAllowed || closed || client?.isConnected == true) return
        if (connecting) reconnectRequested = true else connectSaved()
    }
    private fun connectSaved() {
        if (!enabled() || !reconnectAllowed || connecting || closed) return
        connecting = true
        if (connection.hasSavedIdentity()) status(if (reconnectAttempts > 0) mobileText(R.string.connection_retrying) else mobileText(R.string.connection_connecting), MobileConnectionPhase.Connecting)
        handler.removeCallbacks(retry)
        reconnectRequested = false
        val requestedGeneration = generation
        work {
            try {
                val candidate = connection.connect() ?: run {
                    onUi { if (generation == requestedGeneration) status(mobileText(R.string.connection_not_connected), MobileConnectionPhase.Idle) }
                    return@work
                }
                val identity = candidate.identity ?: throw ProtocolFailure("NOT_CONNECTED")
                if (requestedGeneration != generation) { candidate.close(); return@work }
                val view = SubscriptionProjection(identity, snapshotSerials::incrementAndGet, publish = { topic, items, serial ->
                    val update = Update(candidate, requestedGeneration, topic, items, serial)
                    pending.updateAndGet { previous -> if (client === candidate && generation == requestedGeneration) update else previous }
                    if (scheduled.compareAndSet(false, true)) handler.postDelayed(flushProjection, 16)
                })
                val fresh = ProductSubscription(candidate, schemas, view,
                    state = { state -> onUi { if (client === candidate && generation == requestedGeneration) synchronization(if (state == "RESYNC_REQUIRED") "UNSYNCHRONIZED" else state) } },
                    failure = { error -> onUi { if (client === candidate && generation == requestedGeneration) synchronizationFailure(error) } })
                candidate.onDisconnected = { onUi {
                    if (client === candidate && generation == requestedGeneration) {
                        if (backgroundPoint == null) backgroundPoint = subscription?.checkpoint?.copy(recordedAt = System.nanoTime())
                        released(); status(mobileText(R.string.connection_reconnecting), MobileConnectionPhase.Connecting); requestReconnect()
                    }
                } }
                val published = CompletableFuture<Unit>()
                handler.post {
                    try {
                        if (published.isCancelled || closed || !foreground || requestedGeneration != generation) { fresh.close(); candidate.close(); return@post }
                        view.inherit(backgroundPoint ?: subscription?.checkpoint)
                        releaseConnection()
                        backgroundPoint = null
                        client = candidate; subscription = fresh; reconnectAttempts = 0
                        connected(candidate, identity)
                    } finally { published.complete(Unit) }
                }
                try { published.get(15, TimeUnit.SECONDS) }
                catch (error: Exception) { published.cancel(false); fresh.close(); candidate.close(); throw error }
            } catch (error: Exception) {
                onUi { if (generation == requestedGeneration) {
                    if (recoverable(error)) status(mobileText(R.string.connection_retrying), MobileConnectionPhase.Retrying)
                    else { reconnectAllowed = false; status(failureMessage(error), MobileConnectionPhase.Unavailable) }
                } }
            } finally {
                connecting = false
                onUi {
                    if (reconnectRequested || generation != requestedGeneration) requestReconnect()
                    else if (foreground && reconnectAllowed && client?.isConnected != true && connection.hasSavedIdentity()) {
                        val delay = (1000L shl reconnectAttempts.coerceAtMost(4)).coerceAtMost(15000L)
                        reconnectAttempts++; handler.removeCallbacks(retry); handler.postDelayed(retry, delay)
                    }
                }
            }
        }
    }
    fun close() {
        if (closed) return
        closed = true
        stop()
        handler.removeCallbacks(flushProjection)
        scheduled.set(false)
    }
}
