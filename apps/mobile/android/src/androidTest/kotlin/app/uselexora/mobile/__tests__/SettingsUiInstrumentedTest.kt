package app.uselexora.mobile

import android.widget.EditText
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.ui.*
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import java.io.File

class SettingsUiInstrumentedTest {
    @get:Rule val compose = createComposeRule()
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private var originalTheme = "system"
    private var originalLanguage = "zh"

    @Before fun preferences() {
        compose.runOnUiThread {
            originalTheme = MobileAppearance.theme
            originalLanguage = MobileAppearance.language
            MobileAppearance.selectTheme(context, "light")
            MobileAppearance.selectLanguage(context, "zh")
        }
    }

    @After fun restore() {
        compose.runOnUiThread {
            MobileAppearance.selectTheme(context, originalTheme)
            MobileAppearance.selectLanguage(context, originalLanguage)
        }
    }

    private fun capture(name: String) {
        compose.mainClock.advanceTimeBy(600)
        compose.waitForIdle()
        val bitmap = compose.onRoot().captureToImage().asAndroidBitmap()
        try { File(context.filesDir, name).outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) } }
        finally { bitmap.recycle() }
    }

    private fun previewInk(): Int {
        val bitmap = compose.onNodeWithTag("theme-preview-light", useUnmergedTree = true).captureToImage().asAndroidBitmap()
        try { return bitmap.getPixel((bitmap.width * .35f).toInt(), (bitmap.height * .56f).toInt()) }
        finally { bitmap.recycle() }
    }

    @Test fun themeSelectionKeepsBoundsAndLanguagePickerDoesNotApplyOnDismiss() {
        compose.setContent {
            LexoraTheme {
                Box(Modifier.width(360.dp).height(740.dp)) { AppearanceSettings {} }
            }
        }
        val bounds = compose.onNodeWithTag("theme-dark").fetchSemanticsNode().boundsInRoot
        capture("settings-phone-light.png")
        val lightPreviewInk = previewInk()
        compose.onNodeWithTag("theme-dark").performClick().assertIsSelected()
        compose.onNodeWithTag("theme-light").assertIsNotSelected()
        assertEquals(bounds, compose.onNodeWithTag("theme-dark").fetchSemanticsNode().boundsInRoot)
        capture("settings-phone-dark.png")
        assertEquals("A fixed light preview must keep its text color when the app changes theme", lightPreviewInk, previewInk())
        compose.onNodeWithTag("language-selector").performClick()
        compose.onNodeWithTag("language-en").assertIsDisplayed().assertIsNotSelected()
        InstrumentationRegistry.getInstrumentation().uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
        compose.waitUntil { compose.onAllNodesWithTag("language-en").fetchSemanticsNodes().isEmpty() }
        compose.onNodeWithTag("appearance-settings").assertIsDisplayed()
        compose.runOnIdle { assertEquals("zh", MobileAppearance.language) }
    }

    @Test fun phoneSettingsContainPreferencesAndKeepAboutNavigation() {
        compose.setContent { LexoraTheme { AppearanceSettings {} } }
        for (label in listOf(R.string.label_send_history, R.string.label_local_drafts, R.string.phone_copies)) {
            compose.onNodeWithText(mobileText(label)).assertDoesNotExist()
        }
        compose.onNodeWithTag("about-lexora").performScrollTo().performClick()
        compose.onNodeWithTag("app-version").assertTextEquals(mobileText(R.string.mobile_about_version, BuildConfig.VERSION_NAME))
        compose.onNodeWithTag("about-license").performScrollTo().assertIsDisplayed().assertHasClickAction()
        compose.onNodeWithContentDescription(mobileText(R.string.label_back)).performClick()
        compose.onNodeWithTag("appearance-settings").assertIsDisplayed()
    }

    @Test fun narrowLargeTextKeepsTaskIdentityReadOnlySpaceAndReturnPath() = taskSettingsFlow(true, 1.5f, 320.dp)

    @Test fun normalTextKeepsTaskIdentityReadOnlySpaceAndReturnPath() = taskSettingsFlow(false, 1f, 360.dp)

    private fun taskSettingsFlow(dark: Boolean, fontScale: Float, width: Dp) {
        val variant = if (dark) "dark-large" else "light"
        val state = MobileUiState().apply {
            screen = MobileScreen.Conversation
            connected = true
            connectionLabel = "已连接服务"
            deviceLabel = "设计工作室"
            selectedTask = JSONObject().put("id", "task").put("title", "整理移动端体验与接续方案：完整任务标题")
            selectedTaskSpaceLabel = "移动产品体验与日常创作工作空间：长名称保持单行显示"
            viewBranchId = "main"
            branches = listOf(JSONObject().put("id", "main"), JSONObject().put("id", "alternate").put("parentBranchId", "main"))
            topic = "conversation:task:main"
            membersSupported = true
            executionEnabled = false
        }
        lateinit var input: EditText
        compose.runOnUiThread { input = EditText(context).apply { setText("保留这段尚未发送的输入") } }
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, fontScale)) {
                LexoraTheme(darkTheme = dark) {
                    Box(Modifier.width(width).height(740.dp)) {
                        MobileShell(state, input, { action, _ -> if (action == MobileAction.ChooseExecution) state.executionPickerOpen = true }) { modifier -> Text("已完成的回复正文", modifier) }
                    }
                }
            }
        }
        compose.onNodeWithTag("task-information").assertIsDisplayed().assertWidthIsAtLeast(48.dp).assertHeightIsAtLeast(48.dp)
        compose.onNodeWithContentDescription(mobileText(R.string.label_back)).assertIsDisplayed().assertWidthIsAtLeast(48.dp).assertHeightIsAtLeast(48.dp)
        capture("settings-task-header-$variant.png")
        compose.onNodeWithTag("task-information").performClick()
        compose.onNodeWithText("整理移动端体验与接续方案：完整任务标题").assertIsDisplayed()
        compose.onNodeWithTag("task-space").assertIsDisplayed().assertHasNoClickAction()
        compose.onNodeWithText("设计工作室").assertDoesNotExist()
        compose.onNodeWithTag("execution").assertIsDisplayed().performClick()
        compose.onNodeWithTag("permission-picker").assertIsDisplayed()
        compose.onNodeWithTag("permission-read_only-policy").assertIsNotEnabled()
        compose.runOnIdle { state.executionEnabled = true }
        compose.onNodeWithTag("permission-read_only-policy").assertIsEnabled()
        compose.onNodeWithTag("close-permission-picker").performClick()
        compose.onNodeWithTag("task-partners").assertIsDisplayed()
        capture("settings-task-$variant.png")
        compose.onNodeWithContentDescription(mobileText(R.string.back_conversation)).performClick()
        compose.onNodeWithTag("task-information").assertIsDisplayed()
        compose.runOnIdle {
            assertEquals("保留这段尚未发送的输入", input.text.toString())
            assertEquals("main", state.viewBranchId)
            assertEquals("task", state.selectedTask?.getString("id"))
        }
    }
}
