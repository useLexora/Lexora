package app.uselexora.mobile

import app.uselexora.mobile.protocol.MobileContentAdapter
import android.content.Intent
import android.os.ParcelFileDescriptor
import android.widget.EditText
import androidx.test.core.app.ActivityScenario
import app.uselexora.mobile.ui.MainActivity
import android.os.Process
import androidx.core.content.FileProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.network.MobileConnection
import app.uselexora.mobile.network.MobileFiles
import app.uselexora.mobile.protocol.CommandOutbox
import app.uselexora.mobile.protocol.ProtocolSchemas
import app.uselexora.mobile.storage.LocalFiles
import app.uselexora.mobile.storage.LocalStore
import app.uselexora.mobile.storage.TransferStore
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class ProcessRecoveryInstrumentedTest {
    @Test fun uploadAndUncertainReceiptSurviveProcessTermination() {
        val arguments = InstrumentationRegistry.getArguments()
        val token = arguments.getString("processRecoveryToken")
        assumeTrue(token != null && runCatching { UUID.fromString(token) }.isSuccess)
        val phase = arguments.getString("processRecoveryPhase")
        require(phase in setOf("prepare", "verify"))
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val marker = File(context.filesDir, "process-recovery-$token.json")
        val schemas = ProtocolSchemas(JSONObject(context.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
        val connection = MobileConnection(context, schemas, BuildConfig.VERSION_NAME)
        if (phase == "prepare" && arguments.getString("processRecoveryPairing") == "true") {
            val pairing = ParcelFileDescriptor.AutoCloseInputStream(InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand("cat /data/local/tmp/lexora-recovery-$token.json")).bufferedReader().use { it.readText() }
            connection.pair(JSONObject(pairing).getJSONObject("pairing").toString())
        }
        val client = connection.connect()!!
        LocalStore(context).use { store -> TransferStore(context).use { transfers ->
            val files = MobileFiles(context, transfers, store, connection)
            val owner = client.identity!!.partition
            if (phase == "prepare") {
                val draftId = store.newId()
                val scope = "draft:$draftId"
                val snapshot = store.edit(owner, scope, JSONObject().put("content", MobileContentAdapter.textContent("终止后仍保留😀"))
                    .put("executionConfig", JSONObject().put("executionProfile", "read_only").put("approvalPolicy", "policy")))
                store.edit(owner, "global", JSONObject().put("content", MobileContentAdapter.textContent("重启后当前输入保留😀")))
                val target = JSONObject().put("inputId", snapshot.value.getString("inputId"))
                val source = File(File(context.filesDir, "exports").apply { mkdirs() }, "$token.txt")
                val bytes = "进程恢复😀\n".repeat(50000).toByteArray(Charsets.UTF_8)
                val transfer = try {
                    source.writeBytes(bytes)
                    files.stage(FileProvider.getUriForFile(context, "${context.packageName}.files", source), owner, scope, JSONObject().put("kind", "task").put("draftId", draftId).put("spaceId", JSONObject.NULL))
                } finally { source.delete() }
                val envelope = JSONObject().put("commandId", store.newId()).put("dataGeneration", client.identity!!.dataGeneration)
                    .put("expectedServiceInstanceId", client.identity!!.serviceInstanceId).put("intent", JSONObject(target.toString()).put("file", transfer.getJSONObject("file")))
                val item = store.queue(owner, "uploads.stage", envelope, JSONObject().put("kind", "transfer").put("transferId", transfer.getString("id")).put("scope", scope))
                store.mark(item.id, "unknown")
                val receipt = client.call("uploads.stage", envelope).getJSONObject("receipt")
                assertEquals("accepted", receipt.getString("decision"))
                val uploadId = receipt.getJSONObject("result").getString("uploadId")
                transfer.put("uploadId", uploadId).put("state", "receiving").put("confirmedBytes", 0)
                transfers.save(transfer)
                connection.http(client.identity!!) { transport, credential ->
                    val chunk = bytes.copyOfRange(0, MobileFiles.CHUNK_BYTES / 2)
                    transport.request("/v1/uploads/$uploadId", "PUT", chunk, credential, mapOf("Content-Type" to "application/octet-stream", "Content-Range" to "bytes 0-${chunk.size - 1}/${bytes.size}", "X-Content-SHA256" to MobileFiles.hash(chunk))).use { assertTrue(it.isSuccessful) }
                }
                val state = JSONObject().put("pid", Process.myPid()).put("partition", owner).put("scope", scope).put("transferId", transfer.getString("id"))
                    .put("commandId", item.id).put("envelope", envelope).put("target", target).put("sha256", MobileFiles.hash(bytes))
                FileOutputStream(marker).use { it.write(state.toString().toByteArray(Charsets.UTF_8)); it.fd.sync() }
                CountDownLatch(1).await(180, TimeUnit.SECONDS)
                fail("Process was not terminated")
            } else {
                val state = JSONObject(marker.readText())
                assertNotEquals(state.getInt("pid"), Process.myPid())
                assertEquals(state.getString("partition"), owner)
                val scope = state.getString("scope")
                val item = store.outbox(owner).single { it.id == state.getString("commandId") }
                assertEquals("unknown", item.state); assertNull(item.receipt)
                assertEquals(state.getJSONObject("envelope").toString(), item.envelope.toString())
                assertEquals("终止后仍保留😀", MobileContentAdapter.text(store.draft(owner, scope)!!.value.getJSONObject("content")))
                val transfer = transfers.list(owner).single { it.getString("id") == state.getString("transferId") }
                assertEquals(0L, transfer.getLong("confirmedBytes"))
                assertEquals(state.getString("sha256"), MobileFiles.hash(File(transfer.getString("path"))))
                val remote = client.call("uploads.get", JSONObject().put("uploadId", transfer.getString("uploadId")))
                assertEquals((MobileFiles.CHUNK_BYTES / 2).toLong(), remote.getLong("confirmedBytes"))
                val reconciled = CommandOutbox(store).reconcile(client, item)
                assertEquals("accepted", reconciled.state)
                assertEquals(item.id, reconciled.receipt!!.getString("commandId"))
                val adopted = files.upload(client, transfer, state.getJSONObject("target"))
                assertEquals("accepted", adopted.getString("decision"))
                val repeated = files.upload(client, transfers.list(owner).single { it.getString("id") == transfer.getString("id") }, state.getJSONObject("target"))
                assertEquals(adopted.toString(), repeated.toString())
                val upload = client.call("uploads.get", JSONObject().put("uploadId", transfer.getString("uploadId")))
                assertEquals("ready", upload.getString("state"))
                assertEquals(1, store.draft(owner, scope)!!.value.getJSONObject("content").getJSONArray("panelResourceIds").length())
                assertEquals("终止后仍保留😀", MobileContentAdapter.text(store.draft(owner, scope)!!.value.getJSONObject("content")))
                val commands = store.outbox(owner).size
                ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java)).use { scenario ->
                    fun input() : String { var value = ""; scenario.onActivity { value = it.findViewById<EditText>(MainActivity.INPUT_ID)?.text?.toString().orEmpty() }; return value }
                    MobileUiTestDriver.openDrafts()
                    click("草稿 · 重启后当前输入保留😀")
                    click("继续编辑")
                    waitFor { input() == "重启后当前输入保留😀" }
                    MobileUiTestDriver.openDrafts()
                    click("草稿 · 终止后仍保留😀")
                    click("继续编辑")
                    waitFor { input() == "终止后仍保留😀" }
                    waitFor { MobileUiTestDriver.exists("权限：本机只读") }
                    scenario.recreate()
                    waitFor { input() == "终止后仍保留😀" }
                    assertEquals(commands, store.outbox(owner).size)
                    assertEquals("重启后当前输入保留😀", MobileContentAdapter.text(store.draft(owner, "global")!!.value.getJSONObject("content")))
                    assertEquals(1, store.draft(owner, scope)!!.value.getJSONObject("content").getJSONArray("panelResourceIds").length())
                    InstrumentationRegistry.getInstrumentation().uiAutomation.waitForIdle(700, 5000)
                    InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()?.let { bitmap -> File(context.filesDir, "process-recovery-$token.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle() }
                }
                val localFiles = LocalFiles(context, transfers, store)
                assertFalse(localFiles.list().single { it.record.getString("id") == transfer.getString("id") }.removable)
                assertTrue(marker.delete())
            }
        } }
        client.close()
        if (phase == "verify" && arguments.getString("processRecoveryPairing") == "true") connection.description()?.let { connection.logout(it) }
    }
    private fun click(value: String) = MobileUiTestDriver.click(value)
    private fun waitFor(condition: () -> Boolean) = MobileUiTestDriver.waitUntil(condition = condition)
}
