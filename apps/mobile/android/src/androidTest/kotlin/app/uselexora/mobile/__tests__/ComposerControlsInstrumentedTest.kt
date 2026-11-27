package app.uselexora.mobile

import android.widget.EditText
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
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

    @Test fun newTaskOpensAsOneSurfaceWithoutIntermediateControlsOrLoadingCopy() {
        lateinit var input: EditText
        compose.runOnUiThread { input = EditText(context) }
        val state = MobileUiState().apply {
            screen = MobileScreen.Conversation
            newTaskOpening = true
            inputFeedback = "partial draft status"
            modelLabel = "partial model"
            spaceVisible = true
        }
        val actions = mutableListOf<MobileAction>()
        compose.setContent { LexoraTheme { MobileShell(state, input, { action, _ -> actions.add(action) }) { Box(it) } } }
        compose.onNodeWithTag("new-task-loading").assertIsDisplayed()
        for (tag in listOf("space", "model", "composer-permission", "send", "task-information")) compose.onNodeWithTag(tag).assertDoesNotExist()
        compose.onNodeWithText("partial draft status").assertDoesNotExist()
        compose.onNodeWithContentDescription(app.uselexora.mobile.i18n.mobileText(R.string.label_back)).performClick()
        compose.runOnIdle {
            assertEquals(listOf(MobileAction.Back), actions)
            state.modelLabel = "Service model"
            state.spaceLabel = "Draft space"
            state.executionSelection = ExecutionSettings.modes.last().config()
            state.executionLabel = ExecutionSettings.label(state.executionSelection)
            state.inputFeedback = ""
            state.newTaskOpening = false
        }
        compose.onNodeWithTag("new-task-loading").assertDoesNotExist()
        compose.onNodeWithText("Service model").assertIsDisplayed()
        compose.onNodeWithText("Draft space").assertIsDisplayed()
        compose.onNodeWithTag("composer-permission").assertIsDisplayed()
    }

    @Test fun newTaskOffersPhotoAndFilePickersWithoutSending() {
        val state = MobileUiState().apply {
            screen = MobileScreen.Conversation
            inputEnabled = true
            choosePermissionToSend = true
        }
        lateinit var input: EditText
        compose.runOnUiThread { input = EditText(context).apply { setText("Keep this draft") } }
        val actions = mutableListOf<MobileAction>()
        compose.setContent { LexoraTheme { MobileShell(state, input, { action, _ -> actions.add(action) }) { Box(it) } } }
        compose.onNodeWithTag("composer-permission").assertDoesNotExist()
        compose.onNodeWithText(app.uselexora.mobile.i18n.mobileText(R.string.choose_task_permissions)).assertIsDisplayed().performClick()
        compose.onNodeWithTag("composer-attach").performClick()
        compose.onNodeWithText(app.uselexora.mobile.i18n.mobileText(R.string.mobile_browse_task_files)).assertDoesNotExist()
        compose.onNodeWithText(app.uselexora.mobile.i18n.mobileText(R.string.mobile_local_files_and_uploads)).assertDoesNotExist()
        compose.onNodeWithText(app.uselexora.mobile.i18n.mobileText(R.string.label_choose_file)).assertIsDisplayed()
        compose.onNodeWithText(app.uselexora.mobile.i18n.mobileText(R.string.label_take_photo)).assertIsDisplayed()
        compose.onNodeWithText(app.uselexora.mobile.i18n.mobileText(R.string.label_choose_images)).performClick()
        compose.runOnIdle {
            assertEquals(listOf(MobileAction.ChooseExecution, MobileAction.AttachImages), actions)
            assertEquals("Keep this draft", input.text.toString())
        }
    }

    @Test fun compactDraftKeepsFilesOnTheAttachmentControlAndFailureInTheReader() {
        val state = MobileUiState().apply {
            screen = MobileScreen.Conversation; connected = true; conversationReady = true
            selectedTask = JSONObject().put("id", "task").put("title", "Task")
            viewBranchId = "main"; inputEnabled = true; attachmentCount = 2
            runs = listOf(JSONObject().put("id", "run").put("status", "failed"))
        }
        lateinit var input: EditText
        compose.runOnUiThread { input = EditText(context).apply { showSoftInputOnFocus = false } }
        compose.setContent { LexoraTheme { Box(Modifier.width(320.dp).height(216.dp)) {
            MobileShell(state, input, { _, _ -> }) { modifier -> Box(modifier) }
        } } }
        compose.onNodeWithText(app.uselexora.mobile.i18n.mobileText(R.string.label_task_files)).assertDoesNotExist()
        compose.onNodeWithTag("composer-attach").assertIsDisplayed().performClick()
        compose.onNodeWithText(app.uselexora.mobile.i18n.mobileText(R.string.mobile_browse_task_files)).assertIsDisplayed()
        compose.onNodeWithText(app.uselexora.mobile.i18n.mobileText(R.string.mobile_local_files_and_uploads)).assertDoesNotExist()
    }

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

    private fun capture(name: String, tag: String? = null, includePopup: Boolean = false) {
        val bitmap = if (includePopup) requireNotNull(InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot())
            else (if (tag == null) compose.onRoot() else compose.onNodeWithTag(tag)).captureToImage().asAndroidBitmap()
        try { java.io.File(context.filesDir, name).outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) } }
        finally { bitmap.recycle() }
    }

    @Test fun fullscreenKeepsTheNativeEditorSelectionAndComposingSession() {
        lateinit var input: EditText
        compose.runOnUiThread {
            input = EditText(context).apply {
                showSoftInputOnFocus = false
                inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE
            }
        }
        val state = MobileUiState().apply {
            screen = MobileScreen.Conversation
            selectedTask = JSONObject().put("title", "Draft")
            connected = true
            conversationReady = true
            historyHasMore = false
            inputEnabled = true
            modelLabel = "Qwen"
        }
        val actions = mutableListOf<MobileAction>()
        val viewportHeight = mutableStateOf(640.dp)
        compose.setContent { LexoraTheme { Box(Modifier.width(360.dp).height(viewportHeight.value)) {
            MobileShell(state, input, { action, _ -> actions.add(action) }) { Box(it) }
        } } }
        capture("composer-resting.png")
        val restingHeight = compose.onNodeWithTag("input").fetchSemanticsNode().boundsInRoot.height
        assertTrue(restingHeight <= 56 * context.resources.displayMetrics.density)
        compose.runOnIdle { input.requestFocus() }
        assertEquals(restingHeight, compose.onNodeWithTag("input").fetchSemanticsNode().boundsInRoot.height)
        lateinit var connection: android.view.inputmethod.InputConnection
        lateinit var parent: android.view.ViewParent
        var draft = ""
        var selection = 0
        var composingStart = 0
        var composingEnd = 0
        compose.runOnIdle {
            input.setText("A preserved local draft\nwith another line")
            input.setSelection(3, 9)
        }
        compose.waitUntil(5_000) {
            var active = false
            compose.runOnUiThread { active = (input.context.getSystemService(android.content.Context.INPUT_METHOD_SERVICE) as android.view.inputmethod.InputMethodManager).isActive(input) }
            active
        }
        capture("composer-multiline.png")
        compose.runOnIdle {
            connection = input.onCreateInputConnection(android.view.inputmethod.EditorInfo())!!
            connection.setComposingText("中文输入", 1)
            draft = input.text.toString()
            selection = input.selectionStart
            composingStart = android.view.inputmethod.BaseInputConnection.getComposingSpanStart(input.text)
            composingEnd = android.view.inputmethod.BaseInputConnection.getComposingSpanEnd(input.text)
            parent = input.parent
        }
        val multilineHeight = compose.onNodeWithTag("input").fetchSemanticsNode().boundsInRoot.height
        assertTrue(multilineHeight > restingHeight)
        fun assertDraft() = compose.runOnIdle {
            assertSame(parent, input.parent)
            assertEquals(draft, input.text.toString())
            assertEquals(selection, input.selectionStart)
            assertEquals(selection, input.selectionEnd)
            assertEquals(composingStart, android.view.inputmethod.BaseInputConnection.getComposingSpanStart(input.text))
            assertEquals(composingEnd, android.view.inputmethod.BaseInputConnection.getComposingSpanEnd(input.text))
        }
        assertDraft()
        compose.onNodeWithTag("fullscreen-editor").performClick()
        compose.onNodeWithTag("input").assertHeightIsAtLeast(300.dp)
        compose.onNodeWithTag("send").assertIsDisplayed()
        capture("composer-fullscreen.png")
        assertDraft()
        compose.runOnIdle { viewportHeight.value = 220.dp }
        for (tag in listOf("composer-attach", "composer-permission", "send", "exit-fullscreen-editor")) {
            compose.onNodeWithTag(tag).assertIsDisplayed().assertWidthIsAtLeast(48.dp).assertHeightIsAtLeast(48.dp)
        }
        compose.onNodeWithTag("input").assertHeightIsAtLeast(44.dp)
        assertDraft()
        capture("composer-fullscreen-short.png")
        compose.runOnIdle { viewportHeight.value = 640.dp }
        compose.onNodeWithTag("exit-fullscreen-editor").performClick()
        assertEquals(multilineHeight, compose.onNodeWithTag("input").fetchSemanticsNode().boundsInRoot.height)
        assertDraft()
        compose.runOnIdle {
            connection.commitText("完成输入", 1)
            draft = draft.replaceRange(composingStart, composingEnd, "完成输入")
            assertEquals(draft, input.text.toString())
            input.clearFocus()
        }
        compose.onNodeWithTag("fullscreen-editor").performClick()
        compose.onNodeWithTag("composer-fullscreen").assertIsDisplayed()
        compose.waitForIdle()
        InstrumentationRegistry.getInstrumentation().uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
        compose.waitUntil(5_000) { compose.onAllNodesWithTag("composer-fullscreen").fetchSemanticsNodes().isEmpty() }
        compose.runOnIdle {
            assertTrue(actions.isEmpty())
            assertSame(parent, input.parent)
            assertEquals(draft, input.text.toString())
            input.setText((1..20).joinToString("\n") { "Long draft line $it" })
        }
        assertTrue(compose.onNodeWithTag("input").fetchSemanticsNode().boundsInRoot.height <= kotlin.math.ceil(132 * context.resources.displayMetrics.density))
        compose.onNodeWithTag("send").assertIsDisplayed()
    }

    @Test fun modelListSearchesProviderNamesAndRequiresOneConfirmation() {
        val state = MobileUiState().apply {
            modelPickerOpen = true
            modelProviders = (0 until 80).map { JSONObject().put("id", "provider-$it").put("displayName", "Provider $it") }
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
        assertTrue(longHeight <= context.resources.configuration.screenHeightDp * context.resources.displayMetrics.density * .8f + 1)
        compose.onNodeWithTag("model-search").performTextInput("Provider 79")
        compose.onNodeWithTag("model-option:provider-79:model-79").performClick()
        compose.onNodeWithTag("apply-model").assertIsDisplayed()
        compose.onNodeWithTag("model-provider:provider-79").assertTextEquals("Provider 79")
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

    @Test fun reasoningUsesRawCatalogValuesAndDropsUnsupportedParameters() {
        fun candidate(id: String, reasons: List<String>, fast: Boolean = false) = JSONObject().put("providerId", "local")
            .put("modelId", id).put("displayName", "Model $id").put("reasoningOptions", JSONArray(reasons))
            .put("serviceTiers", if (fast) JSONArray().put(JSONObject().put("id", "priority")) else JSONArray())
        val first = candidate("first", listOf("off", "medium", "high"), true)
        val second = candidate("second", listOf("off", "medium"))
        val state = MobileUiState().apply {
            modelPickerOpen = true
            modelProviders = listOf(JSONObject().put("id", "local").put("displayName", "Local models"))
            models = listOf(first, second)
            modelSelection = MobileModelControls.parameters(first, "high", "priority")
        }
        val selections = mutableListOf<JSONObject>()
        compose.setContent { LexoraTheme {
            ConversationModelPicker(state) { action, value -> if (action == MobileAction.ApplyModel) selections.add(value!!) }
        } }
        val selector = compose.onNodeWithTag("reasoning-selector")
        selector.assertTextContains("high")
        compose.onNodeWithTag("reasoning:off").assertDoesNotExist()
        selector.performClick()
        compose.onNodeWithTag("reasoning:high").assertIsSelected()
        compose.onNodeWithTag("reasoning:off").assertIsNotSelected()
        compose.onNodeWithTag("reasoning:medium").performClick()
        selector.assertTextContains("medium")
        compose.onNodeWithTag("reasoning:high").assertDoesNotExist()
        compose.runOnIdle { assertTrue(selections.isEmpty()); assertEquals("high", state.modelSelection!!.getString("reasoning")) }
        compose.onNodeWithTag("fast-mode").assertIsOn()
        capture("models-parameters.png", "model-picker")
        selector.performClick()
        compose.onNodeWithTag("reasoning:medium").assertIsDisplayed().assertIsSelected()
        capture("models-reasoning-menu.png", includePopup = true)
        InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK)
        selector.assertTextContains("medium")
        compose.onNodeWithTag("reasoning:high").assertDoesNotExist()
        compose.onNodeWithTag("model-list").performScrollToNode(hasTestTag("model-option:local:second"))
        compose.onNodeWithTag("model-option:local:second").performClick()
        selector.assertTextContains("medium")
        selector.performClick()
        compose.onNodeWithTag("reasoning:medium").assertIsSelected()
        compose.onNodeWithTag("reasoning:high").assertDoesNotExist()
        compose.runOnIdle {
            assertTrue(selections.isEmpty())
            state.models = listOf(first, candidate("second", listOf("off")))
        }
        selector.assertTextContains("off")
        compose.onNodeWithTag("reasoning:medium").assertDoesNotExist()
        compose.onNodeWithTag("fast-mode").assertDoesNotExist()
        compose.onNodeWithTag("apply-model").performClick()
        compose.runOnIdle {
            assertEquals("second", selections.single().getString("modelId"))
            assertEquals("off", selections.single().getString("reasoning"))
            assertTrue(selections.single().isNull("serviceTier"))
        }
    }

    @Test fun providerTabsOnlyBrowseAndSearchFindsModelsAcrossProviders() {
        fun candidate(provider: String) = JSONObject().put("providerId", provider).put("modelId", "shared")
            .put("displayName", "Shared model").put("reasoningOptions", JSONArray()).put("serviceTiers", JSONArray())
        val first = candidate("first")
        val second = candidate("second")
        val state = MobileUiState().apply {
            modelPickerOpen = true
            modelProviders = listOf(JSONObject().put("id", "first").put("displayName", "Local models for writing and coding"),
                JSONObject().put("id", "second").put("displayName", "Cloud models"))
            models = listOf(first, second, candidate("second").put("modelId", "another").put("displayName", "Another model"))
            modelSelection = MobileModelControls.parameters(first, null, null)
        }
        val selections = mutableListOf<JSONObject>()
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density * 1.25f, 1.5f)) {
                LexoraTheme(darkTheme = true) {
                    ConversationModelPicker(state) { action, value -> if (action == MobileAction.ApplyModel) selections.add(value!!) }
                }
            }
        }
        compose.onNodeWithTag("model-provider-tab:first").assertIsSelected()
        compose.onNodeWithTag("model-option:first:shared").assertIsSelected()
        compose.onNodeWithTag("model-option:second:shared").assertDoesNotExist()
        val providerBounds = compose.onNodeWithTag("model-providers").fetchSemanticsNode().boundsInRoot
        compose.onNodeWithTag("model-providers").performScrollToNode(hasTestTag("model-provider-tab:second"))
        compose.onNodeWithTag("model-provider-tab:second").performClick()
        compose.onNodeWithTag("model-option:second:shared").assertIsDisplayed().assertIsNotSelected()
        compose.onNodeWithTag("apply-model").assertIsNotEnabled()
        assertEquals(providerBounds, compose.onNodeWithTag("model-providers").fetchSemanticsNode().boundsInRoot)
        compose.runOnIdle { assertTrue(selections.isEmpty()); assertEquals("first", state.modelSelection!!.getString("providerId")) }
        compose.onNodeWithTag("model-search").performTextInput("Shared")
        compose.onNodeWithTag("model-providers-all").assertIsSelected()
        compose.onNodeWithTag("model-list").performScrollToNode(hasTestTag("model-option:first:shared"))
        compose.onNodeWithTag("model-option:first:shared").assertIsDisplayed()
        compose.onNodeWithTag("model-list").performScrollToNode(hasTestTag("model-option:second:shared"))
        compose.onNodeWithTag("model-option:second:shared").performClick()
        compose.onNodeWithTag("apply-model").assertIsDisplayed().assertIsEnabled()
        capture("model-provider-tabs-dark-large.png", "model-picker")
        compose.onNodeWithTag("apply-model").performClick()
        compose.runOnIdle { assertEquals("second", selections.single().getString("providerId")) }
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
