package app.uselexora.mobile

import app.uselexora.mobile.protocol.MobileContentAdapter
import android.os.ParcelFileDescriptor
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.network.MobileConnection
import app.uselexora.mobile.network.PairingClient
import app.uselexora.mobile.protocol.CommandOutbox
import app.uselexora.mobile.protocol.ProductSubscription
import app.uselexora.mobile.protocol.ProtocolSchemas
import app.uselexora.mobile.storage.LocalStore
import app.uselexora.mobile.storage.SecretStore
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class LiveServiceInstrumentedTest {
    @Test fun existingDraftStillMatchesTheNegotiatedSchema() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("livePairingFile") == "/data/local/tmp/lexora-pairing.json")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val schemas = ProtocolSchemas(JSONObject(context.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
        val client = MobileConnection(context, schemas, BuildConfig.VERSION_NAME).connect()!!
        val found = client.exchange("composerDrafts.find", JSONObject().put("scope", JSONObject().put("kind", "global")))
        val draft = found.optJSONObject("draft")
        val output = schemas.document.getJSONObject("methods").getJSONObject("composerDrafts.find").getJSONObject("output")
        val properties = output.getJSONObject("properties").getJSONObject("draft").getJSONArray("anyOf").getJSONObject(0).getJSONObject("properties")
        val failed = if (draft == null) emptyList() else draft.keys().asSequence().filter { !schemas.valid(draft.get(it), properties.getJSONObject(it), output) }.toList()
        assertTrue("Invalid draft fields: $failed", schemas.response("composerDrafts.find", found))
        client.close()
    }
    @Test fun pinnedPairingDraftCommandOutputAndOriginalReceipt() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val path = InstrumentationRegistry.getArguments().getString("livePairingFile")
        assumeTrue(path == "/data/local/tmp/lexora-pairing.json")
        val context = instrumentation.targetContext
        val qr = ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand("cat /data/local/tmp/lexora-pairing.json")).bufferedReader().use { it.readText() }
        val schemas = ProtocolSchemas(JSONObject(context.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
        val identity = PairingClient(SecretStore(context), schemas, BuildConfig.VERSION_NAME).start(qr, "Android emulator verification")
        val client = MobileConnection(context, schemas, BuildConfig.VERSION_NAME).connect()!!
        assertEquals(identity.partition, client.identity!!.partition)
        val store = LocalStore(context)
        val outbox = CommandOutbox(store)
        val scope = JSONObject().put("kind", "global")
        val found = client.call("composerDrafts.find", JSONObject().put("scope", scope))
        val draftId = store.newId()
        val content = MobileContentAdapter.textContent("你好😀 Android 验证固定输出")
        val open = outbox.submit(client, "composerDrafts.open", JSONObject()
            .put("draftId", draftId).put("scope", scope).put("expectedSlotRevision", found.getString("slotRevision"))
            .put("initialContent", content).put("initialExecutionConfig", JSONObject().put("approvalPolicy", "policy").put("executionProfile", "workspace_write"))
            .put("initialModelSelection", JSONObject().put("providerId", "process-fixture").put("modelId", "fixture-model").put("reasoning", JSONObject.NULL).put("serviceTier", JSONObject.NULL)))
        assertEquals("accepted", open.getString("decision"))
        val remote = client.call("composerDrafts.get", JSONObject().put("draftId", draftId))
        assertEquals("你好😀 Android 验证固定输出", MobileContentAdapter.text(remote.getJSONObject("content")))
        val started = outbox.submit(client, "chat.startTurn", JSONObject().put("draftId", draftId).put("expectedRevision", remote.getString("revision")))
        assertEquals("accepted", started.getString("decision"))
        val commandId = started.getString("commandId")
        val runId = started.getJSONObject("target").getString("runId")
        val target = started.getJSONObject("target")
        val done = CountDownLatch(1)
        val subscription = ProductSubscription(client, schemas,
            snapshot = { _, items -> if (items.any { it.optString("entity") == "run" && it.getJSONObject("value").optString("status") in setOf("completed", "failed", "cancelled") }) done.countDown() },
            changes = { _, changes -> if (changes.any { it.optJSONObject("item")?.optString("entity") == "run" && it.getJSONObject("item").getJSONObject("value").optString("status") in setOf("completed", "failed", "cancelled") }) done.countDown() },
            state = {})
        subscription.subscribe("conversation:${android.net.Uri.encode(target.getString("conversationId"))}:${android.net.Uri.encode(target.getString("branchId"))}")
        assertTrue("Run did not reach a terminal synchronized state", done.await(30, TimeUnit.SECONDS))
        val run = client.call("runs.get", JSONObject().put("runId", runId))
        assertEquals("completed", run.getString("status"))
        subscription.close(); client.close()
        val reconnected = MobileConnection(context, schemas, BuildConfig.VERSION_NAME).connect()!!
        val original = reconnected.call("commands.get", JSONObject().put("dataGeneration", identity.dataGeneration).put("commandId", commandId))
        assertEquals("decided", original.getString("lookup"))
        assertEquals(runId, original.getJSONObject("receipt").getJSONObject("target").getString("runId"))
        val messages = reconnected.call("conversations.listMessages", JSONObject().put("conversationId", target.getString("conversationId")).put("branchId", target.getString("branchId"))).getJSONArray("items")
        assertTrue((0 until messages.length()).any { messages.getJSONObject(it).optString("role") == "assistant" })
        reconnected.close(); store.close()
    }
}
