package app.uselexora.mobile

import app.uselexora.mobile.protocol.MobileContentAdapter
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.network.MobileConnection
import app.uselexora.mobile.protocol.ProtocolSchemas
import app.uselexora.mobile.storage.LocalStore
import app.uselexora.mobile.storage.SecretStore
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class PairingLifecycleInstrumentedTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    @Test fun delayedRemovalCannotEraseAReplacementIdentity() {
        val name = "test-identity-${UUID.randomUUID()}"
        val first = SecretStore(context, name)
        val second = SecretStore(context, name)
        try {
            val old = JSONObject().put("credential", "synthetic-first")
            first.write(old)
            val replacement = JSONObject().put("credential", "synthetic-replacement")
            second.write(replacement)
            assertFalse(first.clearIfMatches(old))
            assertEquals("synthetic-replacement", first.read()!!.getString("credential"))
            assertTrue(first.clearIfMatches(replacement))
            assertNull(second.read())
        } finally { first.clear() }
    }
    @Test fun localRemovalPreservesDraftsPendingCommandsAndDownloadedFiles() {
        val secrets = SecretStore(context)
        val previous = secrets.read()
        val partition = "test-forget-${UUID.randomUUID()}"
        val source = File(File(context.filesDir, "exports").apply { mkdirs() }, "$partition.txt").apply { writeText("保留下载的文件") }
        try {
            secrets.write(JSONObject().put("stage", "active").put("endpoint", "https://127.0.0.1:1")
                .put("serviceId", "synthetic-service").put("profileId", "synthetic-profile").put("dataGeneration", "synthetic-generation").put("deviceId", "synthetic-device").put("credential", "synthetic"))
            val schemas = ProtocolSchemas(JSONObject(context.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
            val connection = MobileConnection(context, schemas, BuildConfig.VERSION_NAME)
            LocalStore(context).use { store ->
                store.edit(partition, "global", JSONObject().put("content", MobileContentAdapter.textContent("没有发送的输入")))
                val envelope = JSONObject().put("commandId", UUID.randomUUID().toString())
                store.queue(partition, "chat.startTurn", envelope)
                val expected = connection.description()!!
                assertTrue(runCatching { connection.forget(JSONObject(expected.toString()).put("deviceId", "another-device")) }.isFailure)
                assertNotNull(secrets.read())
                connection.forget(expected)
                assertNull(secrets.read()); assertNull(connection.connect())
                assertEquals("没有发送的输入", MobileContentAdapter.text(store.draft(partition, "global")!!.value.getJSONObject("content")))
                assertEquals(envelope.getString("commandId"), store.outbox(partition).single().id)
                assertEquals("保留下载的文件", source.readText())
            }
        } finally { if (previous == null) secrets.clear() else secrets.write(previous); source.delete() }
    }
}
