package app.uselexora.mobile

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.IntRect
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.ui.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class MessageMenuInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    @Test fun floatingMenuShowsOnlySecondaryActionsAndDismissesOnBack() {
        val visible = mutableStateOf(true)
        val contextual = mutableStateOf(false)
        val selected = mutableListOf<MobileAction>()
        val menu = MobileMessageMenu(
            JSONObject().put("role", "assistant").put("createdAt", "2026-11-11T05:00:00Z"), "reply", true, false, false,
            run = JSONObject().put("status", "completed"), canRegenerate = true, anchor = IntRect(120, 300, 194, 374),
        )
        compose.setContent {
            LexoraTheme(darkTheme = true) {
                Box(Modifier.fillMaxSize()) {
                    if (visible.value) ConversationMessageMenu(menu.copy(contextual = contextual.value), true, { action, _ -> selected.add(action) }) { visible.value = false }
                }
            }
        }
        compose.onNodeWithText(mobileText(R.string.label_run_details)).assertIsDisplayed().performClick()
        assertEquals(listOf(MobileAction.ShowMessageRun), selected)
        for (label in listOf(R.string.label_copy, R.string.label_regenerate, R.string.label_continue_from_here)) {
            compose.onNodeWithText(mobileText(label)).assertDoesNotExist()
        }
        val density = InstrumentationRegistry.getInstrumentation().targetContext.resources.displayMetrics.density
        assertTrue(compose.onNodeWithTag("message-menu").fetchSemanticsNode().boundsInRoot.height <= 120f * density)
        compose.runOnIdle { contextual.value = true }
        for (label in listOf(R.string.label_copy, R.string.label_regenerate, R.string.label_continue_from_here)) {
            compose.onNodeWithText(mobileText(label)).assertIsDisplayed()
        }
        InstrumentationRegistry.getInstrumentation().uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
        compose.waitUntil { !visible.value }
        compose.onNodeWithTag("message-menu").assertDoesNotExist()
    }
}
