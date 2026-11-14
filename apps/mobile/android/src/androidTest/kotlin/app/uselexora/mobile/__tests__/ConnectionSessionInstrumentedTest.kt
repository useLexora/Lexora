package app.uselexora.mobile

import android.net.ConnectivityManager
import android.os.Handler
import android.os.Looper
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.i18n.MobileStrings
import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.network.MobileConnection
import app.uselexora.mobile.protocol.ProtocolSchemas
import app.uselexora.mobile.session.MobileConnectionPhase
import app.uselexora.mobile.session.MobileConnectionSession
import app.uselexora.mobile.storage.SecretStore
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class ConnectionSessionInstrumentedTest {
    @Test fun unpairedForegroundAndBackgroundRemainIdle() = withSession { session, _, work, current ->
        session.start(false)
        session.resume()
        work.removeFirst().invoke()
        assertEquals(mobileText(R.string.connection_not_connected) to MobileConnectionPhase.Idle, current())
        repeat(2) {
            session.stop()
            assertEquals(mobileText(R.string.connection_not_connected) to MobileConnectionPhase.Idle, current())
            session.start(false)
            session.requestReconnect()
            work.removeFirst().invoke()
            assertEquals(mobileText(R.string.connection_not_connected) to MobileConnectionPhase.Idle, current())
        }
    }

    @Test fun savedServiceOnlyShowsConnectingAfterAnAttemptStarts() = withSession { session, secrets, _, current ->
        secrets.write(JSONObject().put("stage", "active").put("endpoint", "https://127.0.0.1:1")
            .put("serviceId", "synthetic-service").put("profileId", "synthetic-profile")
            .put("dataGeneration", "synthetic-generation").put("deviceId", "synthetic-device").put("credential", "synthetic"))
        session.start(false)
        session.stop()
        assertEquals(mobileText(R.string.connection_disconnected) to MobileConnectionPhase.Idle, current())
        session.start(false)
        session.requestReconnect()
        assertEquals(mobileText(R.string.connection_connecting) to MobileConnectionPhase.Connecting, current())
    }

    @Test fun pausedRecoveryPreservesItsFailureAcrossLifecycleChanges() = withSession { session, _, _, current ->
        val failure = current()
        session.reconnectAllowed = false
        session.stop()
        session.start(false)
        session.requestReconnect()
        assertEquals(failure, current())
    }

    private fun withSession(test: (MobileConnectionSession, SecretStore, ArrayDeque<() -> Unit>, () -> Pair<String, MobileConnectionPhase>) -> Unit) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val secrets = SecretStore(context, "test-session-${UUID.randomUUID()}")
        val schemas = ProtocolSchemas(JSONObject(context.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
        instrumentation.runOnMainSync {
            MobileStrings.initialize(context)
            val work = ArrayDeque<() -> Unit>()
            var current = mobileText(R.string.mobile_restoring_connection) to MobileConnectionPhase.Unavailable
            val session = MobileConnectionSession(MobileConnection(context, schemas, BuildConfig.VERSION_NAME, secrets), schemas,
                context.getSystemService(ConnectivityManager::class.java), Handler(Looper.getMainLooper()),
                enabled = { true }, topic = { "taskIndex" }, work = { work.addLast(it) }, onUi = { it() },
                released = {}, connected = { _, _ -> fail("No service should connect") },
                status = { label, phase -> current = label to phase }, failureMessage = { it.toString() },
                synchronization = {}, projection = { _, _ -> }, recoverable = { false })
            try { test(session, secrets, work) { current } }
            finally { session.close(); secrets.clear() }
        }
    }
}
