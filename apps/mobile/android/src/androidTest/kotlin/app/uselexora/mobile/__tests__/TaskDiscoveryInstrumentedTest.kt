package app.uselexora.mobile

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.width
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.ui.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class TaskDiscoveryInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    private fun capture(name: String) {
        compose.waitForIdle()
        val instrumentation = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()
        val bitmap = instrumentation.uiAutomation.takeScreenshot()
        try { java.io.File(instrumentation.targetContext.filesDir, name).outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) } }
        finally { bitmap.recycle() }
    }

    @Test fun cachedHomeOpensTaskDiscoveryWithoutExposingTaskDetails() {
        val state = MobileUiState().apply {
            tasksLoaded = true; connected = false; deviceLabel = "Fixture service"
            tasks = listOf(JSONObject().put("id", "task").put("title", "Private task title").put("activity", "idle"))
        }
        val actions = mutableListOf<MobileAction>()
        compose.setContent { LexoraTheme { Box(Modifier.safeDrawingPadding().width(360.dp).height(740.dp)) { PaperWorkbench(state, state.tasks, { action, _ -> actions.add(action) }, {}, {}) } } }
        compose.onNodeWithText("Private task title").assertDoesNotExist()
        compose.onNodeWithTag("home-all-tasks").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(listOf(MobileAction.ShowTaskFilter), actions) }
    }

    @Test fun offlineConversationShowsCachedContentOrOneConnectionHint() {
        val state = MobileUiState().apply {
            screen = MobileScreen.Conversation
            selectedTask = JSONObject().put("title", "Offline task")
            notice = mobileText(R.string.error_not_connected)
            historyHasMore = true
        }
        compose.setContent {
            val context = androidx.compose.ui.platform.LocalContext.current
            val input = androidx.compose.runtime.remember { android.widget.EditText(context) }
            LexoraTheme { MobileShell(state, input, { _, _ -> }) { modifier ->
                androidx.compose.material3.Text("Cached message", modifier)
            } }
        }
        compose.onNodeWithText(mobileText(R.string.mobile_connect_to_view_conversation)).assertIsDisplayed()
        compose.onNodeWithText(mobileText(R.string.error_not_connected)).assertDoesNotExist()
        compose.onNodeWithText(mobileText(R.string.mobile_load_earlier)).assertDoesNotExist()
        compose.runOnIdle { state.messages = listOf(JSONObject().put("id", "cached")) }
        compose.onNodeWithText("Cached message").assertIsDisplayed()
        compose.onNodeWithText(mobileText(R.string.mobile_connect_to_view_conversation)).assertDoesNotExist()
    }

    @Test fun dismissedUnknownSendCanBeCheckedFromTheInputWithoutSendingOrReplacingNewText() {
        val state = MobileUiState().apply {
            screen = MobileScreen.Conversation; selectedTask = JSONObject().put("id", "task").put("title", "Task")
            connected = true; conversationReady = true; inputEnabled = true
            sendFeedback = mobileText(R.string.error_command_result_unknown); canCheckInputReceipt = true
        }
        val actions = mutableListOf<MobileAction>()
        lateinit var input: android.widget.EditText
        compose.setContent {
            val context = androidx.compose.ui.platform.LocalContext.current
            input = androidx.compose.runtime.remember { android.widget.EditText(context).apply { setText("next input") } }
            LexoraTheme { MobileShell(state, input, { action, _ -> actions.add(action) }) { modifier -> Box(modifier) } }
        }
        val check = mobileText(R.string.send_check_status)
        compose.onNodeWithText(check).assertIsDisplayed()
        compose.onNodeWithContentDescription(mobileText(R.string.label_dismiss_notice)).performClick()
        compose.onNodeWithText(check).assertDoesNotExist()
        compose.onNodeWithTag("composer-attach").performClick()
        compose.onNodeWithText(check).assertIsDisplayed().performClick()
        compose.runOnIdle {
            assertEquals(listOf(MobileAction.CheckInputReceipt), actions)
            assertEquals("next input", input.text.toString())
            state.canCheckInputReceipt = false
            state.sendFeedback = mobileText(R.string.send_failed_reason, "rejected")
        }
        compose.onNodeWithText(mobileText(R.string.send_failed_reason, "rejected")).assertIsDisplayed()
        compose.onNodeWithText(check).assertDoesNotExist()
    }

    @Test fun partialEmptySearchKeepsContinuationAndOfflineSearchDeclaresItsScope() {
        val state = MobileUiState().apply { connected = true; tasksLoaded = true; discovery.supported = true; deviceLabel = "Fixture service" }
        var continued = false
        compose.setContent {
            LexoraTheme { Box(Modifier.safeDrawingPadding().width(360.dp).height(740.dp)) {
                TaskDiscoveryPage(state, emptyList()) { action, payload ->
                    if (action == MobileAction.SearchTasks) {
                        state.discovery.query = payload!!.getString("query")
                        state.discovery.resultScope = "false:null"
                        state.discovery.partial = true
                        state.discovery.cursor = "next-page"
                        state.discovery.loading = false
                        if (payload.optBoolean("more")) continued = true
                    }
                }
            } }
        }
        compose.onNodeWithTag("task-search").performTextInput("needle")
        compose.mainClock.advanceTimeBy(400)
        compose.waitForIdle()
        compose.onNodeWithText(mobileText(R.string.mobile_search_partial)).assertIsDisplayed()
        capture("discovery-partial-search.png")
        compose.onNodeWithText(mobileText(R.string.label_task_not_found)).assertDoesNotExist()
        compose.onNodeWithText(mobileText(R.string.mobile_load_more_results)).performClick()
        compose.runOnIdle { assertTrue(continued); state.connected = false }
        compose.onNodeWithText(mobileText(R.string.mobile_search_cached_summaries)).assertIsDisplayed()
    }

    @Test fun archivedReadAndRestoreRemainSeparateActions() {
        val state = MobileUiState().apply {
            connected = true; tasksLoaded = true; discovery.archiveSupported = true; discovery.archived = true; discovery.archiveLoaded = true
            discovery.archiveItems = listOf(JSONObject().put("id", "archived-task").put("title", "Archived fixture").put("revision", "7"))
        }
        val actions = mutableListOf<MobileAction>()
        compose.setContent { LexoraTheme { Box(Modifier.safeDrawingPadding().width(360.dp).height(740.dp)) { TaskDiscoveryPage(state, emptyList()) { action, _ -> actions.add(action) } } } }
        capture("discovery-archived.png")
        compose.onNodeWithText("Archived fixture").performClick()
        compose.runOnIdle { assertEquals(listOf(MobileAction.OpenArchivedTask), actions) }
        compose.onNodeWithText(mobileText(R.string.mobile_restore_task)).performClick()
        compose.runOnIdle { assertEquals(listOf(MobileAction.OpenArchivedTask, MobileAction.RestoreArchivedTask), actions) }
    }

    @Test fun disabledPartnerCannotBecomeLeadButCanBeRemoved() {
        val state = MobileUiState().apply {
            connected = true; conversationReady = true; membersOpen = true
            memberActions = setOf(MobileAction.AddMember, MobileAction.RemoveMember, MobileAction.SelectBuddy)
            members = JSONObject().put("buddyId", "lead").put("revision", "3").put("items", JSONArray().put(
                JSONObject().put("actorId", "disabled").put("profile", JSONObject().put("id", "disabled").put("name", "Disabled fixture").put("enabled", false).put("deleted", false))
            ))
        }
        compose.setContent { LexoraTheme { TaskMembersPanel(state) { _, _ -> } } }
        compose.onNodeWithText("Disabled fixture").assertIsDisplayed()
        compose.onNodeWithText(mobileText(R.string.mobile_partner_disabled)).assertIsDisplayed()
        compose.onNodeWithTag("partner-actions-disabled").performClick()
        compose.onNodeWithText(mobileText(R.string.mobile_make_lead)).assertIsNotEnabled()
        compose.onNodeWithText(mobileText(R.string.mobile_remove_partner)).assertIsEnabled()
        capture("discovery-members.png")
    }

    @Test fun partnersShowAvatarsAndReadableModelNames() {
        val state = MobileUiState().apply {
            connected = true; conversationReady = true; membersOpen = true
            memberActions = setOf(MobileAction.AddMember)
            models = listOf(JSONObject().put("providerId", "provider").put("modelId", "custom-opaque-id").put("displayName", "Readable model"))
            members = JSONObject().put("buddyId", "default").put("items", JSONArray().put(
                JSONObject().put("actorId", "default").put("profile", JSONObject().put("id", "default").put("name", "Lexora").put("enabled", true))
                    .put("modelSelection", JSONObject().put("providerId", "provider").put("modelId", "custom-opaque-id"))))
            buddyCatalog = listOf(JSONObject().put("id", "candidate").put("name", "New partner").put("enabled", true))
        }
        var added: String? = null
        compose.setContent { LexoraTheme { TaskMembersPanel(state) { action, value -> if (action == MobileAction.AddMember) added = value?.getString("id") } } }
        compose.waitUntil(5_000) { compose.onAllNodesWithTag("partner-image-default", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Readable model").assertIsDisplayed()
        compose.onNodeWithText("custom-opaque-id").assertDoesNotExist()
        compose.onNodeWithTag("partner-avatar-candidate", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithTag("add-partner-candidate").performClick()
        assertEquals("candidate", added)
    }

    @Test fun pairedButUnsynchronizedServiceRetriesDataWithoutAnotherScan() {
        val state = MobileUiState().apply { pairingPhase = "syncing"; connected = true; syncFailure = "Fixture sync failed" }
        val actions = mutableListOf<MobileAction>()
        compose.setContent { LexoraTheme { PairingStatusPanel(state) { actions.add(it) } } }
        compose.onNodeWithText(mobileText(R.string.mobile_pairing_sync)).assertIsDisplayed()
        compose.onNodeWithText("Fixture sync failed").assertIsDisplayed()
        capture("pairing-sync-failed.png")
        compose.onNodeWithText(mobileText(R.string.label_scan_to_connect)).assertDoesNotExist()
        compose.onNodeWithText(mobileText(R.string.label_retry)).performClick()
        compose.runOnIdle { assertEquals(listOf(MobileAction.Refresh), actions); state.pairingPhase = "ready"; state.syncFailure = "" }
        compose.onNodeWithText(mobileText(R.string.mobile_pairing_done)).assertIsDisplayed()
    }
}
