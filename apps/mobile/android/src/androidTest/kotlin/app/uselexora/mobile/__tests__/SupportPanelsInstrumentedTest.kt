package app.uselexora.mobile

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.ui.*
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test

class SupportPanelsInstrumentedTest {
    @get:Rule val compose = createComposeRule()
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private var language = "zh"
    @Before fun setup() { compose.runOnUiThread { language = MobileAppearance.language; MobileAppearance.selectLanguage(context, "en") } }
    @After fun restore() { compose.runOnUiThread { MobileAppearance.selectLanguage(context, language) } }

    @Test fun taskFilesKeepThePreviousPageAndDefaultToPreviewWhenNextPageFails() {
        val resource = JSONObject().put("resourceId", "resource-a").put("name", "report.md").put("mimeType", "text/markdown").put("sizeBytes", 0)
        val panel = MobileTaskFiles("panel", "task-a", listOf(resource), false, "Connection interrupted", "page-2")
        var action: MobileAction? = null
        var selected: JSONObject? = null
        compose.setContent { LexoraTheme { TaskFilesPanel(panel, { next, value -> action = next; selected = value }, {}) } }
        compose.onNodeWithText("report.md").assertIsDisplayed().performClick()
        assertEquals(MobileAction.OpenResource, action)
        assertEquals("resource-a", selected?.getString("resourceId"))
        compose.onNodeWithText("Connection interrupted").assertIsDisplayed()
        compose.onNodeWithTag("retry-task-files").performClick()
        assertEquals(MobileAction.MoreFiles, action)
        compose.onNodeWithText("report.md").assertIsDisplayed()
        assertEquals("page-2", panel.nextCursor)
        compose.onNodeWithTag("manage-phone-copies").assertIsDisplayed().performClick()
        assertEquals(MobileAction.ManageFiles, action)
    }

    @Test fun fileProgressAndRetryStayWithTheFailedFileAndOriginalDeliveryAction() {
        val first = JSONObject().put("resourceId", "first").put("name", "first.txt").put("mimeType", "text/plain")
        val second = JSONObject().put("resourceId", "second").put("name", "second.txt").put("mimeType", "text/plain")
        val panel = androidx.compose.runtime.mutableStateOf(MobileTaskFiles("panel", "task", listOf(first, second), loading = false,
            transfers = mapOf("first" to TaskFileTransferState(loading = true), "second" to TaskFileTransferState(localCopy = true))))
        var selected: JSONObject? = null
        compose.setContent { LexoraTheme { TaskFilesPanel(panel.value, { _, value -> selected = value }, {}) } }
        compose.onNodeWithTag("file-progress-first").assertIsDisplayed()
        compose.onNodeWithText("first.txt").assertIsNotEnabled()
        compose.onNodeWithText("second.txt").assertIsEnabled()
        compose.runOnIdle { panel.value = panel.value.copy(transfers = panel.value.transfers +
            ("first" to TaskFileTransferState(error = "Download interrupted", retryAction = R.string.save_to_files))) }
        compose.onNodeWithTag("file-progress-first").assertDoesNotExist()
        compose.onNodeWithTag("file-error-first").assertTextEquals("Download interrupted")
        compose.onNodeWithTag("file-retry-first").performClick()
        assertEquals("first", selected?.getJSONObject("resource")?.getString("resourceId"))
        assertEquals(R.string.save_to_files, selected?.getInt("fileAction"))
        compose.onNodeWithText("second.txt").assertIsEnabled()
    }

    @Test fun unfinishedAttachmentOnlyInputRemainsRecoverableWithoutBeingMarkedReady() {
        lateinit var activity: android.app.Activity
        compose.setContent { activity = androidx.compose.ui.platform.LocalContext.current as android.app.Activity }
        val partition = "pending-file-ui-${java.util.UUID.randomUUID()}"
        val target = "draft:attachment-only"
        val fileName = "pending-${java.util.UUID.randomUUID()}.txt"
        val restored = java.util.concurrent.atomic.AtomicReference<app.uselexora.mobile.storage.LocalDraft>()
        app.uselexora.mobile.storage.LocalStore(context).use { store ->
            val draft = store.edit(partition, target, JSONObject()
                .put("content", app.uselexora.mobile.protocol.MobileContentAdapter.textContent(""))
                .put("modelSelection", JSONObject().put("providerId", "provider").put("modelId", "model")))
            try {
                compose.runOnIdle {
                    DraftRecoveryPanel(activity, store, { partition }, { it() }, { it() }, { value, _ -> restored.set(value) },
                        targetLabel = { if (it.partition == partition) "Pending task" else null },
                        attachmentSummary = { if (it.partition == partition && it.scope == target && it.value.optString("inputId") == draft.value.optString("inputId")) "$fileName · Upload incomplete" else null }).local()
                }
                MobileUiTestDriver.clickContaining(fileName)
                MobileUiTestDriver.waitUntil { MobileUiTestDriver.contains("Upload incomplete") }
                MobileUiTestDriver.click("CONTINUE EDITING")
                MobileUiTestDriver.waitUntil { restored.get() != null }
                assertEquals(target, restored.get().scope)
                assertEquals(partition, restored.get().partition)
                assertEquals(draft.value.getString("inputId"), restored.get().value.getString("inputId"))
                assertEquals(0, restored.get().value.getJSONObject("content").getJSONArray("panelResourceIds").length())
                assertEquals("model", restored.get().value.getJSONObject("modelSelection").getString("modelId"))
                assertTrue(store.outbox(partition).isEmpty())
            } finally { store.writableDatabase.delete("drafts", "partition=?", arrayOf(partition)) }
        }
    }

    @Test fun savedUnknownReceiptIsReadableOfflineAndCheckingDoesNotResend() {
        lateinit var activity: android.app.Activity
        compose.setContent { activity = androidx.compose.ui.platform.LocalContext.current as android.app.Activity }
        val partition = "history-ui-${java.util.UUID.randomUUID()}"
        val commandId = java.util.UUID.randomUUID().toString()
        val envelope = JSONObject().put("commandId", commandId).put("dataGeneration", "generation")
            .put("expectedServiceInstanceId", "instance").put("intent", JSONObject())
        app.uselexora.mobile.storage.LocalStore(context).use { store ->
            store.queue(partition, "chat.submitInput", envelope)
            store.mark(commandId, "unknown")
            try {
                compose.runOnIdle {
                    CommandHistoryPanel(activity, store, { partition }, { null }, { it() }, { it() }, { it() },
                        { "Offline task" }, {}, {}, {}, {}).show()
                }
                MobileUiTestDriver.clickContaining("Offline task")
                MobileUiTestDriver.waitUntil { MobileUiTestDriver.contains("CHECK ORIGINAL RECEIPT") }
                assertTrue(MobileUiTestDriver.contains(commandId))
                assertFalse(MobileUiTestDriver.contains("Retry original operation"))
                MobileUiTestDriver.click("CHECK ORIGINAL RECEIPT")
                MobileUiTestDriver.waitUntil { MobileUiTestDriver.contains(app.uselexora.mobile.i18n.mobileText(R.string.error_not_connected)) }
                val preserved = store.outbox(partition).single()
                assertEquals(commandId, preserved.id)
                assertEquals("unknown", preserved.state)
                assertEquals(envelope.toString(), preserved.envelope.toString())
                MobileUiTestDriver.click("CLOSE")
            } finally { store.writableDatabase.delete("outbox", "partition=?", arrayOf(partition)) }
        }
    }

    @Test fun sameNamedServicesHaveDistinctAddressesAndClosingDoesNotSwitch() {
        val state = MobileUiState().apply {
            devices = listOf(
                MobileDeviceItem("a", "Studio", "https://studio-a.invalid", selected = true),
                MobileDeviceItem("b", "Studio", "https://studio-b.invalid"),
            )
        }
        var selected: String? = null
        var closed = false
        compose.setContent { LexoraTheme { ServiceSwitcher(state, { _, value -> selected = value?.optString("id") }, { closed = true }) } }
        compose.onNodeWithText("https://studio-a.invalid").assertIsDisplayed()
        compose.onNodeWithText("https://studio-b.invalid").assertIsDisplayed()
        compose.onNodeWithTag("service-a").assertIsSelected()
        compose.onNodeWithTag("service-b").assertIsNotSelected()
        compose.onNodeWithTag("manage-services").assertIsDisplayed()
        compose.onNodeWithTag("scan-service").assertIsDisplayed()
        compose.onNodeWithTag("service-b").performClick()
        assertEquals("b", selected)
        compose.runOnIdle { selected = null; closed = false }
        InstrumentationRegistry.getInstrumentation().uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
        compose.waitUntil { closed }
        assertNull(selected)
    }
}
