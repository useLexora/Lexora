package app.uselexora.mobile

import android.content.Intent
import android.widget.EditText
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
import java.io.File

@RunWith(AndroidJUnit4::class)
class LiveSpaceInstrumentedTest {
    @Test fun selectedSpaceSurvivesRecreationAndDraftChangesReachTheOriginalTaskScope() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("livePairingFile") == "/data/local/tmp/lexora-pairing.json")
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val schemas = ProtocolSchemas(JSONObject(context.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
        val client = MobileConnection(context, schemas, BuildConfig.VERSION_NAME).connect()!!
        val partition = client.identity!!.partition
        val spaces = client.call("spaces.list", JSONObject()).getJSONArray("items")
        val space = (0 until spaces.length()).map { spaces.getJSONObject(it) }.first { it.getString("name") == "Android verification" }
        assertEquals(setOf("id", "name", "memoryScope"), space.keys().asSequence().toSet())
        val input = "空间输入中文😀-${java.util.UUID.randomUUID()}"
        try { LocalStore(context).use { store ->
            ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java)).use { scenario ->
                MobileUiTestDriver.awaitConnected()
                click("新任务")
                waitFor { MobileUiTestDriver.enabled("未分配空间") }
                click("未分配空间")
                click("Android verification")
                scenario.onActivity { it.findViewById<EditText>(MainActivity.INPUT_ID).setText(input) }
                scenario.recreate()
                waitFor { var matches = false; scenario.onActivity { matches = it.findViewById<EditText>(MainActivity.INPUT_ID)?.text?.toString() == input }; matches }
                waitFor { MobileUiTestDriver.exists("Android verification") }
                if (InstrumentationRegistry.getArguments().getString("captureScreenshots") == "true") {
                    instrumentation.uiAutomation.takeScreenshot()?.let { bitmap ->
                        File(context.externalCacheDir, "space-selection.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
                    }
                }
            }
            val local = store.drafts().first { it.partition == partition && MobileContentAdapter.text(it.value.getJSONObject("content")) == input }
            assertEquals(space.getString("id"), DraftContext.spaceId(local.value))
            val target = JSONObject().put("kind", "task").put("draftId", local.scope.removePrefix("draft:")).put("spaceId", JSONObject.NULL)
            val commands = MobileInputCommands(store)
            val unassigned = store.edit(partition, local.scope, JSONObject(local.value.toString()).put("spaceId", JSONObject.NULL))
            assertNull(DraftContext.spaceId(unassigned.value))
            val latest = store.draft(partition, local.scope)!!
            val selected = store.edit(partition, local.scope, JSONObject(latest.value.toString()).put("spaceId", space.getString("id")).put("modelSelection", JSONObject().put("providerId", "process-fixture").put("modelId", "fixture-model").put("reasoning", JSONObject.NULL).put("serviceTier", JSONObject.NULL)))
            val receipt = commands.send(client, selected, target)
            val task = client.call("conversations.get", JSONObject().put("conversationId", receipt.getJSONObject("target").getString("conversationId")))
            assertEquals(space.getString("id"), task.getString("spaceId"))
        } } finally { client.close() }
    }
    private fun click(text: String) = MobileUiTestDriver.click(text)
    private fun waitFor(condition: () -> Boolean) = MobileUiTestDriver.waitUntil(condition = condition)
}
