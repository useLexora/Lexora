package app.uselexora.mobile

import android.content.Intent
import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.network.MobileConnection
import app.uselexora.mobile.protocol.*
import app.uselexora.mobile.storage.LocalStore
import app.uselexora.mobile.ui.MainActivity
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class LiveApprovalInstrumentedTest {
    @Test fun freshReviewSubmitsAnExactDecisionAndAConcurrentResolutionCannotBeApprovedAgain() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("livePairingFile") == "/data/local/tmp/lexora-pairing.json")
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val schemas = ProtocolSchemas(JSONObject(context.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
        val client = MobileConnection(context, schemas, BuildConfig.VERSION_NAME).connect()!!
        val partition = client.identity!!.partition
        try { LocalStore(context).use { store ->
            repeat(2) { attempt ->
                val draftId = store.newId()
                val local = store.edit(partition, "draft:$draftId", JSONObject().put("content", MobileContentAdapter.textContent("Android approval verification $attempt"))
                    .put("executionConfig", JSONObject().put("approvalPolicy", "manual").put("executionProfile", "workspace_write"))
                    .put("modelSelection", JSONObject().put("providerId", "process-fixture").put("modelId", "fixture-model").put("reasoning", JSONObject.NULL).put("serviceTier", JSONObject.NULL)))
                val receipt = MobileInputCommands(store).send(client, local, JSONObject().put("kind", "task").put("draftId", draftId).put("spaceId", JSONObject.NULL))
                val runId = receipt.getJSONObject("target").getString("runId")
                var approval: JSONObject? = null
                waitFor {
                    val items = client.call("approvals.list", JSONObject().put("runId", runId).put("status", "pending")).getJSONArray("items")
                    approval = if (items.length() > 0) items.getJSONObject(0) else null
                    approval != null
                }
                val review = approval!!
                assertTrue(ApprovalReview.decisions(review, client.serverNow()).contains("approved"))
                ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java)).use { scenario ->
                    waitFor { MobileUiTestDriver.connected() }
                    val task = client.call("conversations.get", JSONObject().put("conversationId", receipt.getJSONObject("target").getString("conversationId")))
                    MobileUiTestDriver.openTask(task.getString("title"))
                    MobileUiTestDriver.openApprovals(); click(review.getString("summary"))
                    waitFor { text("操作参数") }
                    val before = store.outbox(partition).filter { it.method == "approvals.resolve" }.size
                    click("选择处理方式")
                    if (attempt == 1) {
                        val other = CommandOutbox(store).submit(client, "approvals.resolve", JSONObject().put("approvalId", review.getString("id")).put("runId", runId).put("reviewVersion", review.getJSONObject("review").getString("reviewVersion")).put("decision", "denied"))
                        assertEquals("accepted", other.getString("decision"))
                    }
                    if (attempt == 0) click("拒绝")
                    else {
                        waitFor { text("已拒绝") }
                        assertFalse(text("选择处理方式")); assertFalse(text("仅本次允许"))
                    }
                    waitFor { client.call("approvals.get", JSONObject().put("approvalId", review.getString("id"))).getString("status") == "denied" }
                    waitFor { store.outbox(partition).count { it.method == "approvals.resolve" } == before + 1 }
                    assertEquals(before + 1, store.outbox(partition).count { it.method == "approvals.resolve" })
                }
            }
        } } finally { client.close() }
        assertTrue(runCatching { client.serverNow() }.isFailure)
    }
    @Test fun largeReviewIsFullyDownloadedBeforeApprovalBecomesAvailable() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("livePairingFile") == "/data/local/tmp/lexora-pairing.json")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val schemas = ProtocolSchemas(JSONObject(context.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
        val connection = MobileConnection(context, schemas, BuildConfig.VERSION_NAME)
        val client = connection.connect()!!
        try { LocalStore(context).use { store ->
            val id = store.newId()
            val local = store.edit(client.identity!!.partition, "draft:$id", JSONObject().put("content", MobileContentAdapter.textContent("Android approval verification large approval document"))
                .put("executionConfig", JSONObject().put("approvalPolicy", "manual").put("executionProfile", "workspace_write"))
                .put("modelSelection", JSONObject().put("providerId", "process-fixture").put("modelId", "fixture-model").put("reasoning", JSONObject.NULL).put("serviceTier", JSONObject.NULL)))
            val receipt = MobileInputCommands(store).send(client, local, JSONObject().put("kind", "task").put("draftId", id).put("spaceId", JSONObject.NULL))
            val runId = receipt.getJSONObject("target").getString("runId")
            var pending: JSONObject? = null
            waitFor {
                val items = client.call("approvals.list", JSONObject().put("runId", runId).put("status", "pending")).getJSONArray("items")
                pending = if (items.length() == 0) null else items.getJSONObject(0)
                pending != null
            }
            val before = pending!!
            assertTrue(before.getJSONObject("review").isNull("document"))
            assertFalse(ApprovalReview.decisions(before, client.serverNow()).contains("approved"))
            val complete = app.uselexora.mobile.network.ApprovalDocuments(connection).get(client, before.getString("id"))
            val review = complete.getJSONObject("review")
            assertTrue(review.getBoolean("complete"))
            assertTrue(ApprovalReview.decisions(complete, client.serverNow()).contains("approved"))
            val document = JSONObject(review.getJSONObject("document").getString("text"))
            assertEquals("中😀".repeat(30000), document.getJSONObject("arguments").getString("content"))
            val latest = client.call("approvals.get", JSONObject().put("approvalId", before.getString("id")))
            assertTrue(latest.getJSONObject("review").isNull("document"))
            assertTrue(ApprovalReview.decisions(app.uselexora.mobile.network.ApprovalDocuments.attach(latest, complete), client.serverNow()).contains("approved"))
            val denied = CommandOutbox(store).submit(client, "approvals.resolve", JSONObject().put("approvalId", before.getString("id")).put("runId", runId).put("reviewVersion", review.getString("reviewVersion")).put("decision", "denied"))
            assertEquals("accepted", denied.getString("decision"))
            val resolved = client.call("approvals.get", JSONObject().put("approvalId", before.getString("id")))
            assertTrue(ApprovalReview.decisions(app.uselexora.mobile.network.ApprovalDocuments.attach(resolved, complete), client.serverNow()).isEmpty())
        } } finally { client.close() }
    }
    private fun text(value: String) = MobileUiTestDriver.contains(value)
    private fun click(value: String) = MobileUiTestDriver.click(value)
    private fun waitFor(condition: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + 15000
        while (SystemClock.uptimeMillis() < deadline) { if (condition()) return; SystemClock.sleep(50) }
        if (!condition()) MobileUiTestDriver.fail("Live approval did not reach its expected state")
    }
}
