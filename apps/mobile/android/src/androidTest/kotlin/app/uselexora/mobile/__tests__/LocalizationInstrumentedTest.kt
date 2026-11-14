package app.uselexora.mobile

import android.content.Intent
import android.widget.EditText
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.ui.MainActivity
import app.uselexora.mobile.ui.MobileAppearance
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.UUID

class LocalizationInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun capture(name: String) {
        instrumentation.waitForIdleSync()
        instrumentation.uiAutomation.waitForIdle(500, 5_000)
        instrumentation.uiAutomation.takeScreenshot().let { bitmap ->
            try { File(context.filesDir, name).outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) } }
            finally { bitmap.recycle() }
        }
    }
    private fun resumeDraft(scenario: ActivityScenario<MainActivity>, text: String) {
        MobileUiTestDriver.click(mobileText(R.string.label_workspace_options))
        MobileUiTestDriver.click(mobileText(R.string.label_local_drafts))
        MobileUiTestDriver.clickContaining(text)
        MobileUiTestDriver.click(mobileText(R.string.mobile_continue_editing).uppercase(app.uselexora.mobile.i18n.MobileStrings.locale))
        MobileUiTestDriver.waitUntil {
            var restored = false
            scenario.onActivity { restored = it.findViewById<EditText>(MainActivity.INPUT_ID)?.text?.toString() == text }
            restored
        }
        scenario.onActivity {
            assertEquals(mobileText(R.string.label_what_would_you_like_lexora_to_do), it.findViewById<EditText>(MainActivity.INPUT_ID).hint.toString())
        }
    }
    @Test fun actualLanguageSelectorRecreatesNativeContextAndPreservesDraft() {
        val original = MobileAppearance.language
        instrumentation.runOnMainSync { MobileAppearance.selectLanguage(context, "zh") }
        try {
            ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("fixture", true)).use { scenario ->
                MobileUiTestDriver.waitUntil { MobileUiTestDriver.exists("新任务") }
                MobileUiTestDriver.click("新任务")
                val text = "${UUID.randomUUID()} 关闭 全部空间 用户草稿😀"
                MobileUiTestDriver.waitUntil {
                    var enabled = false
                    scenario.onActivity { enabled = it.findViewById<EditText>(MainActivity.INPUT_ID)?.isEnabled == true }
                    enabled
                }
                scenario.onActivity { it.findViewById<EditText>(MainActivity.INPUT_ID).setText(text) }
                MobileUiTestDriver.click(mobileText(R.string.label_back))
                MobileUiTestDriver.click(mobileText(R.string.label_appearance_language))
                MobileUiTestDriver.click("English")
                MobileUiTestDriver.waitUntil { MobileUiTestDriver.exists("New task") }
                scenario.onActivity { assertEquals("en", it.resources.configuration.locales[0].language) }
                assertTrue(MobileUiTestDriver.exists("All spaces"))
                capture("i18n-home-en.png")
                resumeDraft(scenario, text)
                capture("i18n-draft-en.png")
                MobileUiTestDriver.click(mobileText(R.string.label_back))
                MobileUiTestDriver.click(mobileText(R.string.label_appearance_language))
                MobileUiTestDriver.waitUntil { MobileUiTestDriver.exists("English") }
                capture("i18n-settings-en.png")
                MobileUiTestDriver.click("简体中文")
                MobileUiTestDriver.waitUntil { MobileUiTestDriver.exists("新任务") }
                scenario.onActivity { assertEquals("zh", it.resources.configuration.locales[0].language) }
                assertTrue(MobileUiTestDriver.exists("全部空间"))
                resumeDraft(scenario, text)
            }
        } finally { instrumentation.runOnMainSync { MobileAppearance.selectLanguage(context, original) } }
    }
}
