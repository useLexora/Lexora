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
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class MessageMenuInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    @Test fun legacyReplyNeedsACompleteResultAndConfirmedResourceRelease() {
        val message = JSONObject().put("role", "assistant").put("runId", "r").put("id", "reply")
        val run = JSONObject().put("id", "r").put("generation", "2").put("lastEventSequence", "8")
        val payload = JSONObject().put("messageId", "reply").put("phase", "commentary")
        val transcript = JSONObject().put("loaded", true).put("sequence", "8").put("events", JSONArray().put(
            JSONObject().put("runId", "r").put("type", "message.completed").put("payload", payload)))
        assertFalse(confirmedLegacyReply(message, run, null))
        assertFalse(confirmedLegacyReply(message, run, transcript))
        payload.put("phase", "final_answer")
        assertTrue(confirmedLegacyReply(message, run, transcript))
        transcript.put("sequence", "7")
        assertFalse(confirmedLegacyReply(message, run, transcript))
        assertFalse(releasedReplyRun(run, null))
        val execution = JSONObject().put("runId", "r").put("generation", "1").put("resources", "released")
        assertFalse(releasedReplyRun(run, execution))
        execution.put("generation", "2")
        assertTrue(releasedReplyRun(run, execution))
    }

    @Test fun floatingMenuNamesTheReplyActionsAndDismissesOnBack() {
        val visible = mutableStateOf(true)
        val contextual = mutableStateOf(false)
        val reply = mutableStateOf(true)
        val selected = mutableListOf<MobileAction>()
        val menu = MobileMessageMenu(
            JSONObject().put("role", "assistant").put("createdAt", "2026-11-11T05:00:00Z"), "reply", true, false, false,
            run = JSONObject().put("status", "completed"), anchor = IntRect(120, 300, 194, 374),
        )
        compose.setContent {
            LexoraTheme(darkTheme = true) {
                Box(Modifier.fillMaxSize()) {
                    if (visible.value) ConversationMessageMenu(menu.copy(contextual = contextual.value, canRegenerate = reply.value, canFollowup = reply.value), true, { action, _ -> selected.add(action) }) { visible.value = false }
                }
            }
        }
        compose.onNodeWithText(mobileText(R.string.label_copy)).assertDoesNotExist()
        for (label in listOf(R.string.message_regenerate_reply, R.string.message_continue_from_reply)) {
            compose.onNodeWithText(mobileText(label)).assertIsDisplayed().performClick()
        }
        compose.onNodeWithText(mobileText(R.string.label_run_details)).assertDoesNotExist()
        assertEquals(listOf(MobileAction.RegenerateMessage, MobileAction.ContinueMessage), selected)
        compose.runOnIdle { contextual.value = true; reply.value = false }
        compose.onNodeWithText(mobileText(R.string.label_copy)).assertIsDisplayed()
        compose.onNodeWithText(mobileText(R.string.message_regenerate_reply)).assertDoesNotExist()
        compose.onNodeWithText(mobileText(R.string.message_continue_from_reply)).assertDoesNotExist()
        InstrumentationRegistry.getInstrumentation().uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
        compose.waitUntil { !visible.value }
        compose.onNodeWithTag("message-menu").assertDoesNotExist()
    }
}
