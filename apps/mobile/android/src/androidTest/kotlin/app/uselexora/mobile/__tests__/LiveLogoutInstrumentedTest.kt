package app.uselexora.mobile

import app.uselexora.mobile.protocol.MobileContentAdapter
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.network.MobileConnection
import app.uselexora.mobile.network.PinnedTransport
import app.uselexora.mobile.protocol.ProtocolSchemas
import app.uselexora.mobile.storage.LocalStore
import app.uselexora.mobile.storage.SecretStore
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class LiveLogoutInstrumentedTest {
    @Test fun logoutRevokesTheCredentialAndSurvivesARepeatedAcknowledgement() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("livePairingFile") == "/data/local/tmp/lexora-pairing.json")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val schemas = ProtocolSchemas(JSONObject(context.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
        val secrets = SecretStore(context)
        val saved = secrets.read()!!
        val connection = MobileConnection(context, schemas, BuildConfig.VERSION_NAME)
        val original = connection.connect()!!
        val partition = original.identity!!.partition
        try { LocalStore(context).use { store ->
            val scope = "draft:${store.newId()}"
            store.edit(partition, scope, JSONObject().put("content", MobileContentAdapter.textContent("退出后也要保留的输入😀")))
            val expected = connection.description()!!
            assertTrue(connection.logout(expected))
            assertNull(secrets.read())
            val deadline = SystemClock.uptimeMillis() + 5000
            while (original.isConnected && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(20)
            assertFalse("The revoked device still has a live subscription", original.isConnected)
            val transport = PinnedTransport(saved.getString("endpoint"), saved.getString("spkiPin"))
            try { transport.request("/v1/device", credential = saved.getString("credential")).use { response ->
                assertEquals(401, response.code)
                assertEquals("NOT_AUTHORIZED", JSONObject(response.body!!.string()).getString("error"))
            } } finally { transport.close() }
            secrets.write(saved)
            assertFalse(connection.logout(expected))
            assertNull(secrets.read())
            assertNull(connection.connect())
            assertEquals("退出后也要保留的输入😀", MobileContentAdapter.text(store.draft(partition, scope)!!.value.getJSONObject("content")))
        } } finally { original.close() }
    }
}
