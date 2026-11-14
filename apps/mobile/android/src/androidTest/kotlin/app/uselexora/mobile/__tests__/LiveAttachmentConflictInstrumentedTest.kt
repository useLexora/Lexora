package app.uselexora.mobile

import app.uselexora.mobile.protocol.MobileContentAdapter
import android.content.Intent
import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.core.app.ActivityScenario
import app.uselexora.mobile.ui.MainActivity
import androidx.core.content.FileProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.network.MobileConnection
import app.uselexora.mobile.network.MobileFiles
import app.uselexora.mobile.network.ProductClient
import app.uselexora.mobile.protocol.CommandOutbox
import app.uselexora.mobile.protocol.LegacyDraftFixture
import app.uselexora.mobile.protocol.ProtocolFailure
import app.uselexora.mobile.protocol.ProtocolSchemas
import app.uselexora.mobile.storage.LocalStore
import app.uselexora.mobile.storage.TransferStore
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class LiveAttachmentConflictInstrumentedTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private class Fixture(val client: ProductClient, val peer: ProductClient, val connection: MobileConnection, val store: LocalStore, val transfers: TransferStore, val files: MobileFiles, val transfer: JSONObject, val target: JSONObject, val uploadId: String)
    private fun fixture(action: (Fixture) -> Unit) {
        assumeTrue(InstrumentationRegistry.getArguments().getString("livePairingFile") == "/data/local/tmp/lexora-pairing.json")
        val schemas = ProtocolSchemas(JSONObject(context.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
        val connection = MobileConnection(context, schemas, BuildConfig.VERSION_NAME)
        val client = connection.connect()!!
        val peer = connection.connect()!!
        LocalStore(context).use { store -> TransferStore(context).use { transfers ->
            val owner = client.identity!!.partition
            val draftId = store.newId()
            val scope = "draft:$draftId"
            val snapshot = store.edit(owner, scope, JSONObject().put("content", MobileContentAdapter.textContent("手机保留的正文😀")))
            val target = LegacyDraftFixture(store).save(client, snapshot, JSONObject().put("kind", "task").put("draftId", draftId).put("spaceId", JSONObject.NULL))
            val source = File(File(context.filesDir, "exports").apply { mkdirs() }, "binding-${store.newId()}.txt").apply { writeText("不可改变的附件内容😀") }
            val files = MobileFiles(context, transfers, store, connection)
            val transfer = try { files.stage(FileProvider.getUriForFile(context, "${context.packageName}.files", source), owner, scope, JSONObject().put("kind", "task").put("draftId", draftId).put("spaceId", JSONObject.NULL)) } finally { source.delete() }
            val effect = JSONObject().put("kind", "transfer").put("transferId", transfer.getString("id")).put("scope", scope)
            transfer.remove("inputId"); transfers.save(transfer)
            val created = CommandOutbox(store).submit(client, "uploads.create", JSONObject(target.toString()).put("file", transfer.getJSONObject("file")), effect)
            assertEquals("accepted", created.getString("decision"))
            val id = created.getJSONObject("result").getString("uploadId")
            try { action(Fixture(client, peer, connection, store, transfers, files, transfer, target, id)) }
            finally { client.close(); peer.close(); File(transfer.getString("path")).delete() }
        } }
    }
    private fun ready(f: Fixture) {
        f.transfer.put("uploadId", f.uploadId).put("draftId", f.target.getString("draftId")).put("expectedRevision", f.target.getString("expectedRevision")).put("state", "receiving")
        f.transfers.save(f.transfer)
        val bytes = File(f.transfer.getString("path")).readBytes()
        f.connection.http(f.client.identity!!) { transport, credential ->
            transport.request("/v1/uploads/${f.uploadId}", "PUT", bytes, credential, mapOf("Content-Type" to "application/octet-stream", "Content-Range" to "bytes 0-${bytes.size - 1}/${bytes.size}", "X-Content-SHA256" to MobileFiles.hash(bytes))).use { assertTrue(it.isSuccessful) }
        }
        val completed = CommandOutbox(f.store).submit(f.client, "uploads.complete", JSONObject().put("uploadId", f.uploadId), JSONObject().put("kind", "transfer").put("transferId", f.transfer.getString("id")).put("scope", f.transfer.getString("scope")))
        assertEquals("accepted", completed.getString("decision"))
    }
    private fun changeRemote(f: Fixture, text: String) {
        val draft = f.peer.call("composerDrafts.get", JSONObject().put("draftId", f.target.getString("draftId")))
        val intent = JSONObject().put("draftId", draft.getString("draftId")).put("expectedRevision", draft.getString("revision")).put("content", MobileContentAdapter.textContent(text))
            .put("executionConfig", draft.get("executionConfig")).put("modelSelection", draft.get("modelSelection")).put("participants", draft.opt("participants") ?: JSONObject.NULL)
        val envelope = JSONObject().put("commandId", f.store.newId()).put("dataGeneration", f.peer.identity!!.dataGeneration).put("expectedServiceInstanceId", f.peer.identity!!.serviceInstanceId).put("intent", intent)
        assertEquals("accepted", f.peer.call("composerDrafts.save", envelope).getJSONObject("receipt").getString("decision"))
    }
    @Test fun explicitAdoptionUsesReviewedRevisionAndCannotSilentlyOverwriteRemoteText() = fixture { f ->
        ready(f); changeRemote(f, "另一连接修改的正文")
        assertEquals("DRAFT_CONFLICT", failure { f.files.upload(f.client, f.transfer, f.target) })
        val owner = f.client.identity!!.partition
        val original = f.store.outbox(owner).single { it.method == "uploads.adopt" && it.localEffect?.optString("transferId") == f.transfer.getString("id") }
        val envelope = original.envelope.toString()
        assertEquals("rejected", original.state)
        val reviewed = f.files.reviewAdoption(f.client, f.transfer)
        assertEquals("另一连接修改的正文", MobileContentAdapter.text(reviewed.getJSONObject("content")))
        changeRemote(f, "审阅后再次修改😀")
        assertEquals("DRAFT_CONFLICT", failure { f.files.adoptReviewed(f.client, f.transfer, reviewed) })
        assertEquals(1, f.store.outbox(owner).count { it.method == "uploads.adopt" && it.localEffect?.optString("transferId") == f.transfer.getString("id") })
        val latest = f.files.reviewAdoption(f.client, f.transfer)
        val adopted = f.files.adoptReviewed(f.client, f.transfer, latest)
        assertEquals("accepted", adopted.getString("decision")); assertNotEquals(original.id, adopted.getString("commandId"))
        assertEquals(envelope, f.store.outbox(owner).single { it.id == original.id }.envelope.toString())
        val remote = f.client.call("composerDrafts.get", JSONObject().put("draftId", f.target.getString("draftId")))
        assertEquals("审阅后再次修改😀", MobileContentAdapter.text(remote.getJSONObject("content")))
        assertEquals(1, remote.getJSONArray("resources").length())
        val local = f.store.draft(owner, f.transfer.getString("scope"))!!
        assertEquals("手机保留的正文😀", MobileContentAdapter.text(local.value.getJSONObject("content")))
        assertEquals(f.target.getString("expectedRevision"), local.value.getString("revision"))
        assertEquals("DRAFT_CONFLICT", failure { LegacyDraftFixture(f.store).save(f.client, local, JSONObject().put("kind", "task").put("draftId", f.target.getString("draftId")).put("spaceId", JSONObject.NULL)) })
        val stale = f.transfers.list(owner).single { it.getString("id") == f.transfer.getString("id") }.put("state", "ready")
        f.transfers.save(stale)
        assertEquals("UPLOAD_ALREADY_ADOPTED", failure { f.files.cancel(f.client, stale) })
        assertEquals("adopted", f.transfers.list(owner).single { it.getString("id") == f.transfer.getString("id") }.getString("state"))
        assertTrue(File(f.transfer.getString("path")).exists())
        assertEquals("adopted", f.client.call("uploads.get", JSONObject().put("uploadId", f.uploadId)).getString("state"))
    }
    @Test fun cancellationRecoversCreatedUploadEvenIfTransferRecordMissedTheAcknowledgement() = fixture { f ->
        assertFalse(f.transfers.list(f.client.identity!!.partition).single { it.getString("id") == f.transfer.getString("id") }.has("uploadId"))
        f.files.cancel(f.client, f.transfer)
        assertEquals("cancelled", f.client.call("uploads.get", JSONObject().put("uploadId", f.uploadId)).getString("state"))
        assertFalse(File(f.transfer.getString("path")).exists())
        val saved = f.transfers.list(f.client.identity!!.partition).single { it.getString("id") == f.transfer.getString("id") }
        assertEquals(f.uploadId, saved.getString("uploadId")); assertEquals("cancelled", saved.getString("state"))
        f.files.cancel(f.client, saved)
        assertEquals("手机保留的正文😀", MobileContentAdapter.text(f.store.draft(f.client.identity!!.partition, f.transfer.getString("scope"))!!.value.getJSONObject("content")))
    }
    @Test fun attachmentConflictCanBeReviewedAndConfirmedFromThePhone() = fixture { f ->
        ready(f); changeRemote(f, "保留服务最新正文 · 界面验证😀")
        assertEquals("DRAFT_CONFLICT", failure { f.files.upload(f.client, f.transfer, f.target) })
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java)).use {
            waitFor { MobileUiTestDriver.connected() }
            fun open() { MobileUiTestDriver.openFiles(); click("本机上传记录"); click(f.transfer.getJSONObject("file").getString("name"), false); click("查看草稿并附加") }
            open()
            waitFor { MobileUiTestDriver.contains("保留服务最新正文") }
            if (InstrumentationRegistry.getArguments().getString("captureScreenshots") == "true") {
                val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
                automation.waitForIdle(300, 5000)
                automation.takeScreenshot()?.let { bitmap -> File(context.externalCacheDir, "attachment-review.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle() }
            }
            click("保留附件")
            assertEquals("ready", f.client.call("uploads.get", JSONObject().put("uploadId", f.uploadId)).getString("state"))
            open(); click("附加到此版本")
            waitFor { f.transfers.list(f.client.identity!!.partition).single { it.getString("id") == f.transfer.getString("id") }.optString("state") == "adopted" }
            val remote = f.client.call("composerDrafts.get", JSONObject().put("draftId", f.target.getString("draftId")))
            assertEquals("保留服务最新正文 · 界面验证😀", MobileContentAdapter.text(remote.getJSONObject("content")))
            assertEquals(1, remote.getJSONArray("resources").length())
        }
    }
    @Test fun changedLocalBytesCannotResumeAnExistingUpload() = fixture { f ->
        f.transfer.put("uploadId", f.uploadId).put("draftId", f.target.getString("draftId")).put("expectedRevision", f.target.getString("expectedRevision"))
        f.transfers.save(f.transfer)
        File(f.transfer.getString("path")).appendText("changed")
        assertEquals("SOURCE_CHANGED", failure { f.files.upload(f.client, f.transfer, f.target) })
        assertEquals(0L, f.client.call("uploads.get", JSONObject().put("uploadId", f.uploadId)).getLong("confirmedBytes"))
        assertTrue(File(f.transfer.getString("path")).exists())
        f.files.cancel(f.client, f.transfer)
        assertEquals("cancelled", f.client.call("uploads.get", JSONObject().put("uploadId", f.uploadId)).getString("state"))
    }
    private fun click(value: String, exact: Boolean = true) = if (exact) MobileUiTestDriver.click(value) else MobileUiTestDriver.clickContaining(value)
    private fun waitFor(condition: () -> Boolean) { val deadline = SystemClock.uptimeMillis() + 15000; while (SystemClock.uptimeMillis() < deadline) { if (condition()) return; SystemClock.sleep(50) }; if (!condition()) MobileUiTestDriver.fail("Attachment review did not reach expected state") }
    private fun failure(action: () -> Unit) = (runCatching(action).exceptionOrNull() as? ProtocolFailure)?.code
}
