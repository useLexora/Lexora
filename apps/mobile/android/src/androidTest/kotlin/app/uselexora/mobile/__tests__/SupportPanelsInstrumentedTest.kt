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
