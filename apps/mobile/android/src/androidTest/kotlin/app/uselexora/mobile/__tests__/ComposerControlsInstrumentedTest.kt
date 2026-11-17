package app.uselexora.mobile

import android.widget.EditText
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.protocol.ExecutionSettings
import app.uselexora.mobile.ui.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class ComposerControlsInstrumentedTest {
    @get:Rule val compose = createComposeRule()
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Test fun narrowLargeTextKeepsStopSeparateDuringTypingAndAttachmentOnlySend() {
        val run = JSONObject().put("id", "active-run").put("generation", "generation-7")
        val state = MobileUiState().apply {
            connected = true
            modelLabel = "A very long model name that must not displace either action"
        }
        val actions = mutableListOf<Pair<MobileAction, JSONObject?>>()
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, 1.6f)) {
                LexoraTheme(darkTheme = true) {
                    Box(Modifier.width(320.dp).padding(horizontal = 18.dp)) {
                        ComposerToolbar(state, { action, value -> actions.add(action to value) }, {}, false, listOf(run), {})
                    }
                }
            }
        }
        for (tag in listOf("composer-attach", "composer-permission", "stop-run", "send")) {
            compose.onNodeWithTag(tag).assertIsDisplayed().assertWidthIsAtLeast(48.dp).assertHeightIsAtLeast(48.dp)
        }
        val stopBounds = compose.onNodeWithTag("stop-run").fetchSemanticsNode().boundsInRoot
        val sendBounds = compose.onNodeWithTag("send").fetchSemanticsNode().boundsInRoot
        assertTrue(stopBounds.right <= sendBounds.left)
        compose.onNodeWithTag("send").assertIsNotEnabled()
        compose.onNodeWithTag("stop-run").performTouchInput { down(center) }
        compose.runOnIdle { state.hasInput = true; state.sendEnabled = true }
        compose.onNodeWithTag("stop-run").performTouchInput { up() }
        compose.runOnIdle {
            assertEquals(listOf(MobileAction.StopRun), actions.map { it.first })
            assertEquals("active-run", actions.single().second!!.getString("id"))
            assertEquals("generation-7", actions.single().second!!.getString("generation"))
            state.attachmentCount = 1
        }
        assertEquals(stopBounds, compose.onNodeWithTag("stop-run").fetchSemanticsNode().boundsInRoot)
        assertEquals(sendBounds, compose.onNodeWithTag("send").fetchSemanticsNode().boundsInRoot)
        compose.onNodeWithTag("send").performClick()
        compose.runOnIdle { assertEquals(listOf(MobileAction.StopRun, MobileAction.Send), actions.map { it.first }) }
    }

    @Test fun replacingTheRunCancelsAnInProgressStopPress() {
        val active = mutableStateOf(listOf(JSONObject().put("id", "old").put("generation", "generation-1")))
        val state = MobileUiState().apply { connected = true }
        val actions = mutableListOf<MobileAction>()
        compose.setContent { LexoraTheme { ComposerToolbar(state, { action, _ -> actions.add(action) }, {}, false, active.value, {}) } }
        compose.onNodeWithTag("stop-run").performTouchInput { down(center) }
        compose.runOnIdle { active.value = listOf(JSONObject().put("id", "replacement").put("generation", "generation-2")) }
        compose.onNodeWithTag("stop-run").performTouchInput { up() }
        compose.runOnIdle { assertTrue(actions.isEmpty()) }
        compose.onNodeWithTag("stop-run").performClick()
        compose.runOnIdle { assertEquals(listOf(MobileAction.StopRun), actions) }
    }

    @Test fun compactEditorKeepsTheNativeInstanceTextAndSelection() {
        lateinit var input: EditText
        compose.runOnUiThread { input = EditText(context).apply { showSoftInputOnFocus = false } }
        val attachment = mutableStateOf(false)
        compose.setContent { LexoraTheme { NativeComposerInput(input, true, attachment.value, 160.dp, false) {} } }
        compose.onNodeWithTag("composer-compact").assertIsDisplayed()
        compose.runOnIdle { attachment.value = true }
        compose.onNodeWithTag("composer-editing").assertIsDisplayed()
        compose.runOnIdle {
            input.setText("A preserved local draft\nwith another line")
            input.setSelection(3, 9)
        }
        compose.onNodeWithTag("collapse-editor").performClick()
        compose.onNodeWithTag("composer-compact").assertIsDisplayed()
        compose.runOnIdle {
            assertEquals("A preserved local draft\nwith another line", input.text.toString())
            assertEquals(3, input.selectionStart)
            assertEquals(9, input.selectionEnd)
            assertEquals(1, input.maxLines)
            assertNotNull(input.parent)
        }
        compose.onNodeWithTag("expand-editor").performClick()
        compose.onNodeWithTag("composer-editing").assertIsDisplayed()
        compose.runOnIdle {
            assertEquals(6, input.maxLines)
            assertEquals(3, input.selectionStart)
            assertEquals(9, input.selectionEnd)
        }
    }

    @Test fun longModelListIsBoundedAndShortParametersRequireExplicitApply() {
        val state = MobileUiState().apply {
            modelPickerOpen = true
            modelPickerShowList = true
            models = (0 until 80).map { index -> JSONObject().put("providerId", "provider-$index").put("modelId", "model-$index")
                .put("displayName", "Same model name").put("reasoningOptions", JSONArray()).put("serviceTiers", JSONArray()) }
        }
        val selections = mutableListOf<JSONObject>()
        compose.setContent {
            LexoraTheme {
                if (state.modelPickerOpen) ConversationModelPicker(state) { action, payload ->
                    if (action == MobileAction.ApplyModel) { selections.add(payload!!); state.modelSelection = payload; state.modelPickerOpen = false }
                }
            }
        }
        val longHeight = compose.onNodeWithTag("model-picker").fetchSemanticsNode().boundsInRoot.height
        compose.onNodeWithTag("model-list").performScrollToNode(hasTestTag("model-option:provider-79:model-79"))
        compose.onNodeWithTag("model-option:provider-79:model-79").performClick()
        compose.onNodeWithTag("apply-model").assertIsDisplayed()
        assertTrue(compose.onNodeWithTag("model-picker").fetchSemanticsNode().boundsInRoot.height < longHeight)
        compose.runOnIdle { assertTrue(selections.isEmpty()) }
        compose.onNodeWithTag("close-model-picker").performClick()
        compose.runOnIdle { assertNull(state.modelSelection); assertTrue(selections.isEmpty()); state.modelPickerOpen = true }
        compose.onNodeWithTag("model-option:provider-0:model-0").performClick()
        compose.onNodeWithTag("apply-model").performClick()
        compose.runOnIdle {
            assertEquals("provider-0", selections.single().getString("providerId"))
            assertEquals("model-0", selections.single().getString("modelId"))
            assertTrue(selections.single().isNull("reasoning"))
            assertTrue(selections.single().isNull("serviceTier"))
        }
    }

    @Test fun ordinaryPermissionAppliesImmediatelyButFullAccessRequiresConfirmation() {
        val state = MobileUiState().apply { executionPickerOpen = true; executionSelection = ExecutionSettings.defaultConfig() }
        val selections = mutableListOf<JSONObject>()
        compose.setContent { LexoraTheme { ConversationPermissionPicker(state) { action, value -> if (action == MobileAction.ApplyExecution) selections.add(value!!) } } }
        compose.onNodeWithTag("permission-read_only-policy").performScrollTo().performClick()
        compose.runOnIdle { assertEquals("read_only", selections.single().getString("executionProfile")) }
        compose.onNodeWithTag("permission-workspace_write-policy").assertIsSelected()
        compose.onNodeWithTag("permission-full_access-policy").performScrollTo().performClick()
        compose.onNodeWithTag("cancel-full-access").performClick()
        compose.runOnIdle { assertEquals(1, selections.size) }
        compose.onNodeWithTag("permission-full_access-policy").performClick()
        compose.runOnIdle { state.executionEnabled = false }
        compose.onNodeWithTag("confirm-full-access").assertIsNotEnabled()
        compose.runOnIdle { state.executionEnabled = true }
        compose.onNodeWithTag("confirm-full-access").performClick()
        compose.runOnIdle { assertEquals(listOf("read_only", "full_access"), selections.map { it.getString("executionProfile") }) }
    }

    @Test fun changingThePermissionTargetDiscardsTheOldElevationConfirmation() {
        val state = MobileUiState().apply { executionPickerOpen = true; executionSelection = ExecutionSettings.defaultConfig(); topic = "conversation:first:main" }
        val selections = mutableListOf<JSONObject>()
        compose.setContent { LexoraTheme { ConversationPermissionPicker(state) { _, value -> selections.add(value!!) } } }
        compose.onNodeWithTag("permission-full_access-policy").performScrollTo().performClick()
        compose.onNodeWithTag("confirm-full-access").assertIsDisplayed()
        compose.runOnIdle { state.topic = "conversation:second:main" }
        compose.onNodeWithTag("confirm-full-access").assertDoesNotExist()
        compose.runOnIdle { assertTrue(selections.isEmpty()) }
    }
}
