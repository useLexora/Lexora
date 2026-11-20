package app.uselexora.mobile

import android.content.Intent
import android.os.ParcelFileDescriptor
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.network.MobileConnection
import app.uselexora.mobile.protocol.MobileContentAdapter
import app.uselexora.mobile.protocol.ProtocolSchemas
import app.uselexora.mobile.storage.LocalStore
import app.uselexora.mobile.ui.MainActivity
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class TaskModelSelectionInstrumentedTest {
    @get:Rule val compose = createEmptyComposeRule()

    @Test fun confirmChangesTaskMemberWithoutSendingDraft() {
        val token = InstrumentationRegistry.getArguments().getString("taskModelToken")
        assumeTrue(token?.matches(Regex("[a-f0-9-]{36}")) == true)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val config = JSONObject(ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand("cat /data/local/tmp/lexora-desktop-$token.json")).bufferedReader().use { it.readText() })
        val conversation = JSONObject().put("conversationId", config.getString("conversationId"))
        val wanted = config.getJSONObject("selection")
        val schemas = ProtocolSchemas(JSONObject(context.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
        val connection = MobileConnection(context, schemas, BuildConfig.VERSION_NAME)
        val identity = connection.pair(config.getJSONObject("pairing").toString())
        val paired = requireNotNull(connection.description())
        try {
            val client = requireNotNull(connection.connect())
            val task = client.call("conversations.get", conversation)
            val actor = task.getString("buddyId")
            fun member(): JSONObject {
                val items = client.call("conversations.listMembers", conversation).getJSONArray("items")
                return (0 until items.length()).map { items.getJSONObject(it) }.single { it.getString("actorId") == actor }
            }
            val original = member().getJSONObject("modelSelection")
            assertNotEquals(original.getString("modelId"), wanted.getString("modelId"))
            val scope = "conversation:${task.getString("id")}:${task.getString("activeBranchId")}"
            val text = "手机未发送的草稿 $token"
            val ui = MobileUiTestDriver
            LocalStore(context).use { store ->
                fun savedText() = store.draft(identity.partition, scope)?.value?.getJSONObject("content")?.let { MobileContentAdapter.text(it) }
                fun modelWrites() = store.outbox(identity.partition).filter { it.method == "conversations.setModelSelection" }
                ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java)).use { scenario ->
                    fun awaitNode(matcher: SemanticsMatcher): SemanticsNodeInteraction {
                        compose.waitUntil(15_000) { compose.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty() }
                        return compose.onNode(matcher)
                    }
                    fun clickEnabled(tag: String) = awaitNode(hasTestTag(tag) and isEnabled()).performClick()
                    awaitNode(hasTestTag("space-filter")).assertIsDisplayed()
                    clickEnabled("home-all-tasks")
                    awaitNode(hasAnyAncestor(hasTestTag("task-list")) and hasText(task.getString("title")) and hasClickAction()).performClick()
                    awaitNode(hasTestTag("model") and isEnabled()).assertIsDisplayed()
                    ui.setComposerText(text)
                    compose.waitUntil(15_000) { ui.composerText() == text && savedText() == text }
                    clickEnabled("model")
                    clickEnabled("model-option:${wanted.getString("providerId")}:${wanted.getString("modelId")}")
                    clickEnabled("reasoning-selector")
                    val reasonTag = "reasoning:${wanted.getString("reasoning")}"
                    compose.onNodeWithTag(reasonTag).assertIsNotSelected()
                    clickEnabled(reasonTag)
                    assertTrue(modelWrites().isEmpty())
                    assertEquals(original.getString("modelId"), member().getJSONObject("modelSelection").getString("modelId"))
                    clickEnabled("apply-model")
                    compose.waitUntil(15_000) { modelWrites().any { it.receipt != null } }
                    val command = modelWrites().single()
                    assertEquals(command.receipt.toString(), "accepted", command.state)
                    val committed = member()
                    assertEquals("explicit", committed.getString("modelSelectionSource"))
                    val selection = committed.getJSONObject("modelSelection")
                    for (field in listOf("providerId", "modelId", "reasoning")) assertEquals(field, wanted.getString(field), selection.getString(field))
                    compose.waitUntil(15_000) { ui.composerText() == text }
                    scenario.recreate()
                    compose.waitUntil(15_000) { ui.composerText() == text && savedText() == text }
                    assertTrue(store.outbox(identity.partition).none { it.method == "chat.submitInput" })
                }
            }
        } finally { connection.logout(paired) }
    }
}
