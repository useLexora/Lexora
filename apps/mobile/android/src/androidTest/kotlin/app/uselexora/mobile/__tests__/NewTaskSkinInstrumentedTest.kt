package app.uselexora.mobile

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.widget.EditText
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.core.widget.doAfterTextChanged
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.ui.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.File
import kotlin.math.abs

class NewTaskSkinInstrumentedTest {
    @get:Rule val compose = createComposeRule()
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val space = "示例空间"
    private val draft = "整理周末阅读清单"

    @Test fun sixVariantsRenderPackagedArtAndKeepNativeDraft() {
        val original = compose.runOnUiThread {
            MobileAppearance.load(context)
            Triple(MobileAppearance.skinId, MobileAppearance.theme, MobileAppearance.language)
        }
        try {
            compose.runOnUiThread {
                MobileAppearance.selectLanguage(context, "zh")
                MobileAppearance.selectSkin(context, "paper")
                MobileAppearance.selectTheme(context, "light")
            }
            val state = MobileUiState().apply {
                screen = MobileScreen.Conversation
                connected = true
                spaceLabel = space
            }
            lateinit var input: EditText
            var spaceRequests = 0
            compose.setContent {
                val host = LocalContext.current
                input = remember { EditText(host).apply {
                    showSoftInputOnFocus = false
                    doAfterTextChanged { state.sendEnabled = !it.isNullOrBlank() }
                } }
                LexoraTheme {
                    MobileShell(state, input, { action, _ -> if (action == MobileAction.ChooseSpace) spaceRequests++ }) {
                        error("A fresh task must not render a conversation timeline")
                    }
                }
            }
            compose.onNodeWithTag("space").assertIsEnabled().performClick()
            compose.runOnIdle { assertEquals(1, spaceRequests) }
            MobileUiTestDriver.setComposerText(draft)
            compose.runOnIdle { input.setSelection(2) }

            for (mode in listOf("light", "dark")) for (skin in listOf("paper", "color-play", "mecha-armor")) {
                val label = "$skin-$mode"
                compose.runOnIdle {
                    MobileAppearance.selectSkin(context, skin)
                    MobileAppearance.selectTheme(context, mode)
                }
                compose.waitUntil(10_000) { compose.onAllNodesWithTag("new-task-art-ready", useUnmergedTree = true).fetchSemanticsNodes().size == 1 }
                val art = compose.onNodeWithTag("new-task-art-ready", useUnmergedTree = true).assertIsDisplayed()
                val panel = compose.onNodeWithTag("new-task-composer", useUnmergedTree = true).assertIsDisplayed()
                compose.onNodeWithTag("space").assertIsDisplayed().assertTextContains(space)
                compose.onNodeWithTag("input", useUnmergedTree = true).assertIsDisplayed()
                compose.onNodeWithTag("send").assertIsEnabled()
                compose.runOnIdle {
                    assertTrue(label, input.isAttachedToWindow && input.isShown && input.isEnabled)
                    assertEquals(label, draft, input.text.toString())
                    assertEquals(label, 2, input.selectionStart)
                }
                assertEquals(label, draft, MobileUiTestDriver.composerText())
                val page = compose.onRoot().captureToImage().asAndroidBitmap()
                try {
                    File(context.filesDir, "new-task-$label.png").outputStream().use { assertTrue(label, page.compress(Bitmap.CompressFormat.PNG, 100, it)) }
                } finally { page.recycle() }
                val variant = BuiltinSkins.get(context, skin).variant(mode == "dark")
                val rendered = art.captureToImage().asAndroidBitmap()
                try {
                    assertRenderedArt(label, rendered, requireNotNull(variant.newTask).illustration.path, MobileTheme.color(variant.palette, "canvas").toArgb())
                } finally { rendered.recycle() }
                val surface = panel.captureToImage().asAndroidBitmap()
                try {
                    val expected = MobileTheme.color(variant.palette, "composer").toArgb()
                    var exact = 0
                    var total = 0
                    for (y in 2 until surface.height step 5) for (x in 2 until surface.width step 5) {
                        if (surface.getPixel(x, y) == expected) exact++
                        total++
                    }
                    android.util.Log.i("NewTaskSkinTest", "$label composer=${Integer.toHexString(expected)} exact=$exact/$total")
                    assertTrue("$label: expected panel ${Integer.toHexString(expected)} at >50% of pixels, got $exact/$total", exact * 2 > total)
                } finally { surface.recycle() }
            }
        } finally {
            compose.runOnUiThread {
                MobileAppearance.selectSkin(context, original.first)
                MobileAppearance.selectTheme(context, original.second)
                MobileAppearance.selectLanguage(context, original.third)
            }
        }
    }

    private fun assertRenderedArt(label: String, rendered: Bitmap, path: String, canvasColor: Int) {
        val asset = context.assets.open(path).use { requireNotNull(BitmapFactory.decodeStream(it)) }
        val reference = Bitmap.createBitmap(rendered.width, rendered.height, Bitmap.Config.ARGB_8888)
        try {
            Canvas(reference).apply {
                drawColor(canvasColor)
                drawBitmap(asset, null, Rect(0, 0, width, height), Paint(Paint.FILTER_BITMAP_FLAG))
            }
            var foreground = 0
            var matched = 0
            for (y in 1 until rendered.height step 3) for (x in 1 until rendered.width step 3) {
                val expected = reference.getPixel(x, y)
                if (rgbDistance(expected, canvasColor) <= 32) continue
                foreground++
                if (rgbDistance(expected, rendered.getPixel(x, y)) <= 24) matched++
            }
            android.util.Log.i("NewTaskSkinTest", "$label art=$path matched=$matched/$foreground")
            assertTrue("$label: image is blank or differs from $path ($matched/$foreground foreground samples)", foreground >= 20 && matched > foreground * .8)
        } finally { reference.recycle(); asset.recycle() }
    }

    private fun rgbDistance(a: Int, b: Int) = maxOf(abs(Color.red(a) - Color.red(b)), abs(Color.green(a) - Color.green(b)), abs(Color.blue(a) - Color.blue(b)))
}
