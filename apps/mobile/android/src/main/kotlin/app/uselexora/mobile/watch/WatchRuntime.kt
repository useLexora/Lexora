package app.uselexora.mobile.watch

import android.content.Context
import android.net.ConnectivityManager
import android.os.Handler
import android.os.Looper
import app.uselexora.mobile.BuildConfig
import app.uselexora.mobile.MobileApplication
import app.uselexora.mobile.network.MobileConnection
import app.uselexora.mobile.notifications.MobileNotifier
import app.uselexora.mobile.notifications.NotificationLedger
import app.uselexora.mobile.notifications.NotificationPolicy
import app.uselexora.mobile.notifications.NotificationSettings
import app.uselexora.mobile.notifications.TaskNotificationEvent
import app.uselexora.mobile.notifications.TaskNotificationPolicy
import app.uselexora.mobile.notifications.TaskNotificationState
import app.uselexora.mobile.protocol.ProductIdentity
import app.uselexora.mobile.protocol.ProductProjection
import app.uselexora.mobile.session.MobileConnectionPhase
import app.uselexora.mobile.session.MobileConnectionSession
import app.uselexora.mobile.session.MobileOperationFailure
import app.uselexora.mobile.ui.MobileFailurePresentation
import org.json.JSONObject
import java.time.ZoneId
import java.util.concurrent.Executors

internal data class WatchStatus(val phase: MobileConnectionPhase, val synchronized: Boolean, val paused: Boolean = false)

internal class WatchRuntime private constructor(private val context: Context) {
    private val settings = NotificationSettings(context)
    private val ledger = NotificationLedger(context)
    private val notifier = MobileNotifier(context)
    private val handler = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private val connection = MobileConnection(context, MobileApplication.schemas(context), BuildConfig.VERSION_NAME)
    @Volatile private var detached = true
    @Volatile var status = WatchStatus(MobileConnectionPhase.Idle, false)
        private set
    var onStatus: ((WatchStatus) -> Unit)? = null
    private var previous: List<TaskNotificationState>? = null
    private var partition = ""
    private val uiTasks = ProductProjection()
    @Volatile private var suppressed: String? = null

    private val session = MobileConnectionSession(
        connection, MobileApplication.schemas(context), context.getSystemService(ConnectivityManager::class.java), handler,
        enabled = { !detached && settings.read().watchEnabled },
        topic = { "taskIndex" },
        work = { operation -> worker.execute { operation() } },
        onUi = { operation -> handler.post { operation() } },
        released = { publish(status.copy(synchronized = false)) },
        connected = { _, identity -> onConnected(identity) },
        status = { _, phase -> publish(status.copy(phase = phase, synchronized = false)) },
        failureMessage = { error -> MobileFailurePresentation.message(MobileOperationFailure.from(error)) },
        synchronization = { state -> publish(status.copy(synchronized = state == "SYNCHRONIZED")) },
        projection = { topic, items, _ -> onProjection(topic, items) },
        recoverable = { error -> MobileOperationFailure.from(error).code == "SERVICE_UNREACHABLE" },
    )

    fun resume() {
        if (!settings.read().watchEnabled) {
            pause()
            return
        }
        notifier.ensureChannels()
        detached = false
        publish(status.copy(paused = false))
        if (!connection.hasSavedIdentity()) {
            previous = null
            notifier.clearAll()
            publish(WatchStatus(MobileConnectionPhase.Idle, false))
            return
        }
        session.start()
    }

    fun pause() {
        detached = true
        publish(WatchStatus(MobileConnectionPhase.Idle, false, paused = true))
        session.stop()
    }

    fun isEnabled(): Boolean = settings.read().watchEnabled

    fun suppress(conversationId: String?) {
        suppressed = conversationId
    }

    fun feedSnapshot(partition: String, items: List<JSONObject>) = handler.post {
        runCatching { uiTasks.snapshot(TOPIC, items); project(partition, uiTasks.view()) }
    }

    fun feedChanges(partition: String, changes: List<JSONObject>) = handler.post {
        runCatching { uiTasks.apply(TOPIC, changes); project(partition, uiTasks.view()) }
    }

    private fun onConnected(identity: ProductIdentity) {
        if (identity.partition != partition) {
            notifier.clearAll()
            previous = null
            partition = identity.partition
        }
        session.subscription?.subscribe(TOPIC)
    }

    private fun onProjection(topic: String, items: List<JSONObject>) {
        if (topic != TOPIC) return
        val identity = session.client?.identity ?: return
        project(identity.partition, items)
    }

    private fun project(partition: String, items: List<JSONObject>) {
        if (partition.isEmpty()) return
        if (partition != this.partition) {
            notifier.clearAll()
            previous = null
            this.partition = partition
        }
        val snapshot = settings.read()
        val states = items.mapNotNull { TaskNotificationState.from(it) }
        val notified = ledger.notified(this.partition, states)
        val now = System.currentTimeMillis()
        val quiet = NotificationPolicy.isQuiet(snapshot.preferences(), NotificationPolicy.minutesOfDay(now, ZoneId.systemDefault()))
        val events = TaskNotificationPolicy.evaluate(previous, states, snapshot.preferences(), quiet, now,
            settings.mutedConversationIds(this.partition), notified)
        previous = states
        val viewing = if (status.paused) suppressed else null
        for (event in events) {
            when (event) {
                is TaskNotificationEvent.Show -> {
                    if (event.conversationId != viewing) notifier.show(this.partition, event, snapshot)
                    event.runId?.let { ledger.record(this.partition, event.conversationId, it) }
                }
                is TaskNotificationEvent.Retract -> notifier.retract(event.conversationId, event.kind)
            }
        }
    }

    private fun publish(value: WatchStatus) {
        status = value
        onStatus?.invoke(value)
    }

    companion object {
        private const val TOPIC = "taskIndex"
        @Volatile private var shared: WatchRuntime? = null

        fun shared(context: Context): WatchRuntime = shared ?: synchronized(this) {
            shared ?: WatchRuntime(context.applicationContext).also { shared = it }
        }

        fun existing(): WatchRuntime? = shared
    }
}
