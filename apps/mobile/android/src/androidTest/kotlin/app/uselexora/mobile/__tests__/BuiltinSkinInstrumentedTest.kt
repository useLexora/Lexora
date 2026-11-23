package app.uselexora.mobile

import android.widget.EditText
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.i18n.mobileQuantity
import app.uselexora.mobile.ui.*
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import java.io.File

class BuiltinSkinInstrumentedTest {
    @get:Rule val compose = createComposeRule()
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private var originalSkin = "paper"
    private var originalTheme = "system"
    private var originalLanguage = "zh"

    @Before fun preferences() {
        compose.runOnUiThread {
            originalSkin = MobileAppearance.skinId
            originalTheme = MobileAppearance.theme
            originalLanguage = MobileAppearance.language
            MobileAppearance.selectSkin(context, "paper")
            MobileAppearance.selectTheme(context, "light")
            MobileAppearance.selectLanguage(context, "zh")
        }
    }

    @After fun restore() {
        compose.runOnUiThread {
            MobileAppearance.selectSkin(context, originalSkin)
            MobileAppearance.selectTheme(context, originalTheme)
            MobileAppearance.selectLanguage(context, originalLanguage)
        }
    }

    private fun state() = MobileUiState().apply {
        connected = true; connectionLabel = mobileText(R.string.connection_connected); deviceLabel = "Design studio"
        devices = listOf(MobileDeviceItem("fixture", "Design studio", "fixture.invalid", selected = true, connected = true))
        tasksLoaded = true; marksLoaded = true; markedTaskIds = setOf("approval", "reading")
        tasks = listOf(
            JSONObject().put("id", "approval").put("activity", "awaiting_approval").put("pendingQuestionCount", 0).put("unread", true),
            JSONObject().put("id", "question").put("activity", "idle").put("pendingQuestionCount", 2).put("unread", true),
            JSONObject().put("id", "reading").put("activity", "running").put("pendingQuestionCount", 0).put("unread", true),
        )
    }

    private fun capture(name: String) {
        compose.waitUntil(5_000) {
            compose.onAllNodes(SemanticsMatcher.keyIsDefined(SkinImageReady), useUnmergedTree = true)
                .fetchSemanticsNodes().all { it.config[SkinImageReady] }
        }
        compose.waitForIdle()
        val bitmap = compose.onRoot().captureToImage().asAndroidBitmap()
        try { File(context.filesDir, name).outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) } }
        finally { bitmap.recycle() }
    }

    private fun assertSingleLineFits(layout: TextLayoutResult, description: String) {
        assertEquals(description, 1, layout.lineCount)
        assertFalse(description, layout.isLineEllipsized(0))
        assertTrue(description, layout.getLineRight(0) - layout.getLineLeft(0) <= layout.size.width + 1)
        assertTrue(description, layout.multiParagraph.height <= layout.size.height + 1)
    }

    @Test fun settingsApplyAndPersistSkinWithoutChangingModeOrDraft() {
        val state = state()
        lateinit var input: EditText
        var canvas = 0
        compose.runOnUiThread { input = EditText(context).apply { setText("Unsent input stays here"); setSelection(8) } }
        compose.setContent {
            LexoraTheme {
                val color = MaterialTheme.colorScheme.background.toArgb()
                SideEffect { canvas = color }
                Box(Modifier.width(360.dp).height(780.dp)) {
                    MobileShell(state, input, { action, _ -> if (action == MobileAction.NewTask) state.screen = MobileScreen.Conversation }) { modifier ->
                        Text("Existing conversation", modifier)
                    }
                }
            }
        }
        compose.onNodeWithTag("workbench-settings").performClick()
        compose.onNodeWithTag("skin-settings").performScrollTo().performClick()
        compose.onNodeWithTag("builtin-skins").assertIsDisplayed()
        compose.onNodeWithTag("skin-color-play").performScrollTo().performClick().assertIsSelected()
        compose.runOnIdle {
            assertEquals("color-play", MobileAppearance.skinId)
            assertEquals("light", MobileAppearance.theme)
            assertEquals(MobileTheme.color(BuiltinSkins.get(context, "color-play").variant(false).palette, "canvas").toArgb(), canvas)
            MobileAppearance.load(context)
            assertEquals("color-play", MobileAppearance.skinId)
        }
        val covers = listOf("paper", "color-play", "mecha-armor").map { compose.onNodeWithTag("skin-$it").getUnclippedBoundsInRoot() }
        assertTrue(covers.all { it.top == covers.first().top && it.bottom - it.top > it.right - it.left })
        capture("skins-selection.png")
        compose.onNodeWithContentDescription(mobileText(R.string.label_back)).performClick()
        compose.onNodeWithTag("theme-dark").performClick().assertIsSelected()
        compose.onNodeWithTag("skin-settings").performScrollTo().performClick()
        compose.onNodeWithTag("skin-mecha-armor").performScrollTo().performClick().assertIsSelected()
        compose.runOnIdle { assertEquals("dark", MobileAppearance.theme) }
        compose.onNodeWithContentDescription(mobileText(R.string.label_back)).performClick()
        compose.onNodeWithContentDescription(mobileText(R.string.label_close_settings)).performClick()
        compose.onNodeWithTag("new-task").performScrollTo().performClick()
        compose.onNodeWithTag("input").assertIsDisplayed()
        compose.runOnIdle {
            assertEquals("Unsent input stays here", input.text.toString())
            assertEquals(8, input.selectionStart)
            assertEquals("mecha-armor", MobileAppearance.skinId)
            assertEquals("dark", MobileAppearance.theme)
        }
    }

    private fun fontInkCoverage(path: String, weight: Int): Long {
        val face = android.graphics.Typeface.Builder(context.assets, path).setFontVariationSettings("'wght' $weight").setWeight(weight).build()
        val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { typeface = face; textSize = 64f; color = android.graphics.Color.WHITE; isFakeBoldText = false }
        val bitmap = android.graphics.Bitmap.createBitmap(kotlin.math.ceil(paint.measureText("Lexora")).toInt() + 16, 96, android.graphics.Bitmap.Config.ARGB_8888)
        return try {
            android.graphics.Canvas(bitmap).drawText("Lexora", 8f, 76f, paint)
            val pixels = IntArray(bitmap.width * bitmap.height)
            bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
            pixels.sumOf { (it ushr 24).toLong() }
        } finally { bitmap.recycle() }
    }

    @Test fun bundledMaterialsAndTypefacesDecodeOnAndroid() {
        val testedFonts = mutableSetOf<String>()
        for (skin in BuiltinSkins.list(context)) for (dark in listOf(false, true)) {
            val document = skin.variant(dark).home ?: continue
            val home = requireNotNull(decodeSkinHome(document, "skins/${skin.id}/")) { skin.id }
            for (style in home.surfaces.values) style.image?.let { image ->
                val bitmap = requireNotNull(context.assets.open(image.path).use { android.graphics.BitmapFactory.decodeStream(it) }) { image.path }
                try {
                    assertTrue(image.path, bitmap.width > 0 && bitmap.height > 0)
                    assertTrue(skinImagePatches(bitmap.width, bitmap.height, 390, 160, image.insets).isNotEmpty())
                } finally { bitmap.recycle() }
            }
            for (font in listOfNotNull(home.typography.fontFamily, home.typography.brandFontFamily).filter { testedFonts.add(it) }) {
                val typeface = android.graphics.Typeface.createFromAsset(context.assets, font)
                assertNotNull(font, typeface)
                val paint = android.graphics.Paint().apply { this.typeface = typeface }
                for (glyph in listOf("漢", "😀")) assertTrue("$font fallback $glyph", paint.hasGlyph(glyph))
                assertTrue("$font must provide real variable-weight outlines", fontInkCoverage(font, 700) > fontInkCoverage(font, 400) * 1.08)
            }
        }
    }

    @Test fun colorPlayLightHomePreservesActionsAndCounts() = home("color-play", false, false)
    @Test fun colorPlayDarkLargeHomePreservesActionsAndCounts() = home("color-play", true, true)
    @Test fun mechaLightHomePreservesActionsAndCounts() = home("mecha-armor", false, false)
    @Test fun mechaDarkLargeHomePreservesActionsAndCounts() = home("mecha-armor", true, true)
    @Test fun colorPlayDarkHomePreservesActionsAndCounts() = home("color-play", true, false)
    @Test fun mechaDarkHomePreservesActionsAndCounts() = home("mecha-armor", true, false)
    @Test fun colorPlayEnglishLargeHomePreservesActionsAndCounts() = home("color-play", false, true, "en")
    @Test fun mechaEnglishLargeHomePreservesActionsAndCounts() = home("mecha-armor", false, true, "en")

    private fun home(skinId: String, dark: Boolean, large: Boolean, language: String = "zh") {
        val state = state()
        val actions = mutableListOf<Pair<MobileAction, JSONObject?>>()
        var devices = 0
        var settings = 0
        compose.runOnUiThread {
            MobileAppearance.selectSkin(context, skinId)
            MobileAppearance.selectTheme(context, if (dark) "dark" else "light")
            MobileAppearance.selectLanguage(context, language)
            state.connectionLabel = mobileText(R.string.connection_connected)
            if (large) state.deviceLabel = "A very long studio service name that must not cover the settings button"
        }
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, if (large) 1.5f else 1f)) {
                LexoraTheme {
                    Box(Modifier.width(if (large) 320.dp else 390.dp).fillMaxHeight().background(MaterialTheme.colorScheme.background)) {
                        PaperWorkbench(state, state.tasks, { action, payload -> actions.add(action to payload) }, { devices++ }, { settings++ })
                    }
                }
            }
        }
        capture("skin-$skinId-${if (dark) "dark" else "light"}${if (large) "-large" else ""}${if (language == "en") "-en" else ""}.png")
        val skinHome = requireNotNull(decodeSkinHome(BuiltinSkins.get(context, skinId).variant(dark).home, "skins/$skinId/"))
        if (skinId == "mecha-armor" && !large) {
            val first = compose.onNodeWithTag("home-unread").getUnclippedBoundsInRoot()
            val last = compose.onNodeWithTag("home-all-tasks").getUnclippedBoundsInRoot()
            val bay = compose.onNodeWithTag("workbench-shortcut-bay", useUnmergedTree = true).getUnclippedBoundsInRoot()
            val footer = compose.onNodeWithTag("workbench-footer", useUnmergedTree = true).getUnclippedBoundsInRoot()
            assertEquals("Equal space above and below the shortcuts", (first.top - bay.top).value, (bay.bottom - last.bottom).value, 1f)
            assertEquals("Centered horizontally", (first.left - bay.left).value, (bay.right - first.right).value, 1f)
            assertEquals("Continuous armor up to the footer", bay.bottom.value, footer.top.value, 1f)
            compose.onNodeWithTag("workbench-footer", useUnmergedTree = true).assertHeightIsAtLeast(skinHome.layout.footerHeight.dp)
        }
        compose.onNodeWithTag("workbench-brand-icon", useUnmergedTree = true).assertWidthIsEqualTo(skinHome.layout.brandIconSize.dp)
        for ((surfaceTag, contentTag, region) in listOf(
            Triple("service-selector-surface", "service-selector-content", skinHome.layout.serviceContentBounds),
            Triple("space-filter-surface", "space-filter-content", skinHome.layout.spaceContentBounds),
        )) {
            val surface = compose.onNodeWithTag(surfaceTag, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
            val content = compose.onNodeWithTag(contentTag, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
            assertEquals(contentTag, surface.left + surface.width * region.x, content.left, 1.5f)
            assertEquals(contentTag, surface.center.y + surface.height * (region.y + region.height / 2 - .5f), content.center.y, 1.5f)
            assertTrue(contentTag, content.right <= surface.right && content.bottom <= surface.bottom)
        }
        if (skinHome.layout.serviceLayout == "panel") {
            val host = compose.onNodeWithTag("service-host-label", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
            val status = compose.onNodeWithTag("service-state-label", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
            assertEquals("host and status share their text anchor", host.left, status.left, 1.5f)
        }
        val titleLayouts = mutableListOf<TextLayoutResult>()
        compose.onNode(hasText(mobileText(R.string.label_new_task)) and hasAnyAncestor(hasTestTag("new-task")), useUnmergedTree = true)
            .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(titleLayouts) }
        val titleLayout = titleLayouts.single()
        val titleDiagnostic = "$skinId/$language: size=${titleLayout.size}, paragraph=${titleLayout.multiParagraph.width}x${titleLayout.multiParagraph.height}, font=${titleLayout.layoutInput.style.fontSize}, spacing=${titleLayout.layoutInput.style.letterSpacing}"
        assertSingleLineFits(titleLayout, titleDiagnostic)
        val settingsLabels = compose.onAllNodes(hasText(mobileText(R.string.skin_home_settings)) and hasAnyAncestor(hasTestTag("workbench-settings")), useUnmergedTree = true)
        repeat(settingsLabels.fetchSemanticsNodes().size) { index ->
            val layouts = mutableListOf<TextLayoutResult>()
            settingsLabels[index].performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
            assertSingleLineFits(layouts.single(), "$skinId/$language settings")
        }
        compose.onNodeWithTag("workbench-settings").assertIsDisplayed().assertHeightIsAtLeast(48.dp)
            .assertContentDescriptionEquals(mobileText(R.string.mobile_phone_settings)).performClick()
        compose.onNodeWithTag("service-selector").assertIsDisplayed().assertHeightIsAtLeast(48.dp).performClick()
        compose.onNodeWithTag("space-filter").performScrollTo().assertHeightIsAtLeast(48.dp).performClick()
        compose.onNodeWithTag("new-task").performScrollTo().assertHasClickAction().performClick()
        for ((tag, meaning, count) in listOf(
            Triple("home-approvals", R.plurals.approval_tasks, 1), Triple("home-questions", R.plurals.question_tasks, 1),
            Triple("home-unread", R.plurals.unread_tasks, 3), Triple("home-marked", R.plurals.marked_tasks, 2),
            Triple("home-all-tasks", R.plurals.mobile_tasks, 3),
        )) {
            compose.onNodeWithTag(tag).performScrollTo()
            compose.onNodeWithTag(tag).assertIsDisplayed().assertHeightIsAtLeast(48.dp)
                .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, mobileQuantity(meaning, count))).performClick()
            val badge = compose.onNode(hasTestTag("skin-count") and hasAnyAncestor(hasTestTag(tag)), useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
            assertEquals("single-digit count retains its intended aspect ratio", badge.height * skinHome.typography.countAspectRatio, badge.width, 1.5f)
            if (tag in setOf("home-unread", "home-marked", "home-all-tasks")) {
                val entry = compose.onNodeWithTag(tag).fetchSemanticsNode().boundsInRoot
                val icon = compose.onNodeWithTag("$tag-icon", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
                val label = compose.onNodeWithTag("$tag-label", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
                with(compose.density) {
                    assertEquals("$tag icon inset", entry.left + skinHome.layout.shortcutPadding.left.dp.toPx(), icon.left, 1.5f)
                    assertEquals("$tag label anchor", icon.right + 16.dp.toPx(), label.left, 1.5f)
                    assertEquals("$tag trailing count anchor", entry.right - (skinHome.layout.shortcutPadding.right + 34f).dp.toPx(), badge.right, 1.5f)
                }
            }
        }
        compose.runOnIdle {
            assertEquals(1, devices); assertEquals(1, settings)
            assertTrue(actions.any { it.first == MobileAction.NewTask })
            assertTrue(actions.any { it.first == MobileAction.ChooseSpaceFilter })
            assertEquals(setOf("Approvals", "Questions", "Unread", "Marked", "All"),
                actions.filter { it.first == MobileAction.ShowTaskFilter }.map { it.second!!.getString("filter") }.toSet())
            state.connected = false
            state.tasksLoaded = false
            state.marksLoaded = false
            state.connectionLabel = mobileText(R.string.connection_disconnected)
        }
        compose.onNodeWithTag("workbench-settings").performScrollTo()
        compose.onNodeWithTag("space-filter").assertDoesNotExist()
        compose.onNodeWithTag("home-unread").performScrollTo()
        compose.onNodeWithTag("home-unread").assertIsDisplayed().assert(
            SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, mobileText(R.string.label_count_unavailable)))
        compose.onNodeWithTag("home-all-tasks").performScrollTo()
        compose.onNodeWithTag("home-all-tasks").assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals("All", actions.last().second!!.getString("filter")) }
    }
}
