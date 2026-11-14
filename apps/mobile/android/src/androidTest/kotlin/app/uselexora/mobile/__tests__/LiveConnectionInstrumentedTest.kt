package app.uselexora.mobile

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.network.MobileConnection
import app.uselexora.mobile.protocol.ProtocolSchemas
import app.uselexora.mobile.storage.SecretStore
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class LiveConnectionInstrumentedTest {
    @Test fun addressChangeRetainsIdentityAndFailurePreservesTheWorkingEndpoint() {
        val arguments = InstrumentationRegistry.getArguments()
        assumeTrue(arguments.getString("livePairingFile") == "/data/local/tmp/lexora-pairing.json")
        val alternate = arguments.getString("liveAlternateEndpoint")
        assumeTrue(alternate != null)
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val schemas = ProtocolSchemas(JSONObject(context.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
        val secrets = SecretStore(context)
        val saved = secrets.read()!!
        val connection = MobileConnection(context, schemas, BuildConfig.VERSION_NAME)
        val initial = connection.connect()!!
        val identity = initial.identity!!
        initial.close()
        try {
            assertEquals(identity.partition, connection.updateEndpoint(alternate!!).partition)
            assertEquals(alternate, connection.description()!!.getString("endpoint"))
            assertFalse(connection.description()!!.has("credential"))
            assertEquals(saved.getString("credential"), secrets.read()!!.getString("credential"))
            for (invalid in listOf("http://127.0.0.1:19443", "https://user:secret@127.0.0.1", "https://127.0.0.1/v1/rpc", "https://127.0.0.1:1")) {
                assertTrue(runCatching { connection.updateEndpoint(invalid) }.isFailure)
                assertEquals(alternate, secrets.read()!!.getString("endpoint"))
            }
            val connected = connection.connect()!!
            assertEquals(identity.partition, connected.identity!!.partition)
            connected.close()
        } finally { secrets.write(saved) }
    }
}
