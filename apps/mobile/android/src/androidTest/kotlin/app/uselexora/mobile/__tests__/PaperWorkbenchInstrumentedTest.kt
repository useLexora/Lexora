package app.uselexora.mobile

import app.uselexora.mobile.i18n.mobileText
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.ui.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.File

class PaperWorkbenchInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    private fun state() = MobileUiState().apply {
        connected = true; connectionLabel = "已连接服务"; deviceLabel = "工作室服务"
        devices = listOf(MobileDeviceItem("fixture", "工作室服务", "fixture.invalid", selected = true, connected = true))
        tasksLoaded = true; marksLoaded = true; markedTaskIds = setOf("approval", "reading")
        tasks = listOf(
            JSONObject().put("id", "approval").put("activity", "awaiting_approval").put("pendingQuestionCount", 0).put("unread", true),
            JSONObject().put("id", "question").put("activity", "idle").put("pendingQuestionCount", 2).put("unread", true),
            JSONObject().put("id", "reading").put("activity", "running").put("pendingQuestionCount", 0).put("unread", true),
        )
    }

    @Test fun serviceStatusReplacesSpaceFilterAndPreservesServiceSwitching() {
        val state = state().apply { devicePlatform = "linux"; deviceLabel = "工作室的长名称服务" }
        var switches = 0
        var spaceSelections = 0
        compose.setContent {
            LexoraTheme(darkTheme = false) {
                Box(Modifier.width(320.dp).height(780.dp).background(MaterialTheme.colorScheme.background)) {
                    PaperWorkbench(state, emptyList(), { action, _ -> if (action == MobileAction.ChooseSpaceFilter) spaceSelections++ }, { switches++ }, {})
                }
            }
        }
        capture("service-status-connected.png")
        compose.onNodeWithTag("space-filter").assertIsDisplayed().performClick()
        compose.onNodeWithTag("connection-detail").assertDoesNotExist()
        compose.runOnIdle {
            assertEquals(1, spaceSelections)
            state.connected = false
            state.connectionPhase = app.uselexora.mobile.session.MobileConnectionPhase.Retrying
            state.connectionLabel = "暂时无法连接，正在重试"
        }
        compose.onNodeWithTag("space-filter").assertDoesNotExist()
        compose.onNodeWithTag("connection-detail").assertTextEquals("暂时无法连接，正在重试").assertIsDisplayed()
        compose.onNodeWithTag("service-selector").assertHeightIsAtLeast(48.dp)
        val selector = compose.onNodeWithTag("service-selector").fetchSemanticsNode().boundsInRoot
        val detail = compose.onNodeWithTag("connection-detail").fetchSemanticsNode().boundsInRoot
        assertTrue(selector.right < detail.left)
        capture("service-status-retrying.png")
        compose.onNodeWithTag("service-selector").performClick()
        compose.runOnIdle {
            assertEquals(1, switches)
            state.connectionPhase = app.uselexora.mobile.session.MobileConnectionPhase.Connecting
            state.connectionLabel = "正在连接…"
        }
        compose.onNodeWithTag("connection-detail").assertTextEquals("正在连接…")
        compose.runOnIdle { state.connected = true; state.connectionLabel = "已连接服务"; state.selectedSpaceId = "studio"; state.selectedSpaceLabel = "工作空间" }
        compose.onNodeWithTag("connection-detail").assertDoesNotExist()
        compose.onNodeWithText("工作空间").assertIsDisplayed()
    }

    @Test fun darkServiceStatusSupportsLargeTextAndLongFailureDetails() {
        compose.setContent {
            androidx.compose.runtime.CompositionLocalProvider(androidx.compose.ui.platform.LocalDensity provides androidx.compose.ui.unit.Density(androidx.compose.ui.platform.LocalDensity.current.density, 1.5f)) {
                LexoraTheme(darkTheme = true) {
                    Box(Modifier.width(320.dp).height(780.dp).background(MaterialTheme.colorScheme.background)) {
                        PaperWorkbench(state().apply {
                            connected = false; devicePlatform = "win32"
                            deviceLabel = "工作室的长名称服务"
                            connectionPhase = app.uselexora.mobile.session.MobileConnectionPhase.Unavailable
                            connectionLabel = "设备授权已失效 · 本地输入保留，请重新配对"
                        }, emptyList(), { _, _ -> }, {}, {})
                    }
                }
            }
        }
        compose.onNodeWithTag("connection-detail").assertIsDisplayed()
        val bar = compose.onNodeWithTag("service-status-bar").fetchSemanticsNode().boundsInRoot
        val detail = compose.onNodeWithTag("connection-detail").fetchSemanticsNode().boundsInRoot
        assertTrue(detail.right <= bar.right && detail.bottom <= bar.bottom)
        capture("service-status-dark-large.png")
    }

    @Test fun serviceSwitcherCentersItsEmptyMessageBelowTheHeader() {
        showServiceSwitcher(MobileUiState())
        compose.onNodeWithText(mobileText(R.string.label_no_saved_services)).assertIsDisplayed()
        val area = compose.onNodeWithTag("service-empty-area").fetchSemanticsNode().boundsInRoot
        val message = compose.onNodeWithTag("service-empty-message").fetchSemanticsNode().boundsInRoot
        assertEquals(area.center.x, message.center.x, 1f)
        assertEquals(area.center.y, message.center.y, 1f)
        compose.onNodeWithTag("scan-service").assertIsDisplayed().assertHasClickAction()
        captureSwitcher("service-switcher-empty.png")
    }

    @Test fun serviceSwitcherSeparatesSwitchingFromReconnectingAndKeepsCompactTouchTargets() {
        val state = MobileUiState().apply {
            devices = listOf(
                MobileDeviceItem("first", "工作室服务", "first.invalid", selected = true, platform = "linux"),
                MobileDeviceItem("second", "家庭服务", "second.invalid", platform = "win32"),
            )
        }
        val targets = mutableListOf<String>()
        showServiceSwitcher(state) { action, payload ->
            assertEquals(MobileAction.SelectDevice, action)
            targets.add(payload!!.getString("id"))
        }
        compose.onNodeWithTag("service-first").assertIsSelected().assertHasNoClickAction()
        captureSwitcher("service-switcher-offline.png")
        compose.onNodeWithTag("service-second").assertIsNotSelected().assertHasClickAction().assertTextContains(mobileText(R.string.service_switch)).performClick()
        val button = compose.onNodeWithTag("connect-service-first").assertIsEnabled().assertHeightIsAtLeast(48.dp).assertWidthIsAtLeast(48.dp)
        compose.onNodeWithTag("service-action-surface-first", useUnmergedTree = true).assertHeightIsEqualTo(32.dp)
        val row = compose.onNodeWithTag("service-first").fetchSemanticsNode().boundsInRoot
        val bounds = button.fetchSemanticsNode().boundsInRoot
        assertTrue(row.contains(bounds.topLeft) && bounds.right <= row.right && bounds.bottom <= row.bottom)
        button.performClick()
        compose.runOnIdle { assertEquals(listOf("second", "first"), targets) }
        compose.runOnIdle { state.devices = state.devices.map { it.copy(selected = false) } }
        for (id in listOf("first", "second")) compose.onNodeWithTag("service-$id").assertIsNotSelected().assertHasClickAction().assertTextContains(mobileText(R.string.service_connect))
    }

    @Test fun serviceSwitcherShowsLiveConnectionStateIndependentlyOfTheSelectedBorder() {
        val state = state().apply { devices = devices.map { it.copy(platform = "linux") } + MobileDeviceItem("other", "家庭服务", "other.invalid", platform = "darwin") }
        showServiceSwitcher(state)
        compose.onNodeWithText(mobileText(R.string.label_connected)).assertIsDisplayed()
        compose.onNodeWithTag("service-fixture").assertIsSelected().assertHasNoClickAction()
        compose.onNodeWithTag("service-other").assertIsNotSelected().assertHasClickAction().assertTextContains(mobileText(R.string.service_switch))
        captureSwitcher("service-switcher-connected.png")
        compose.runOnIdle {
            state.devices = state.devices.map { it.copy(connected = false) }
            state.connectionPhase = app.uselexora.mobile.session.MobileConnectionPhase.Connecting
        }
        compose.onNodeWithText(mobileText(R.string.service_connecting)).assertIsDisplayed()
        compose.onNodeWithTag("service-fixture").assertIsSelected().assertHasNoClickAction()
        compose.onNodeWithTag("service-other").assertHasClickAction()
        captureSwitcher("service-switcher-connecting.png")
        compose.runOnIdle { state.connectionPhase = app.uselexora.mobile.session.MobileConnectionPhase.Idle }
        compose.onNodeWithTag("service-fixture").assertIsSelected()
        compose.onNodeWithTag("connect-service-fixture").assertIsEnabled().assertTextContains(mobileText(R.string.service_connect))
        compose.runOnIdle {
            state.devices = state.devices.map { it.copy(selected = it.id == "other") }
            state.connectionPhase = app.uselexora.mobile.session.MobileConnectionPhase.Connecting
        }
        compose.onNodeWithTag("service-fixture").assertIsNotSelected().assertHasClickAction()
        compose.onNodeWithTag("service-other").assertIsSelected().assertHasNoClickAction()
        compose.onNodeWithText(mobileText(R.string.service_connecting)).assertIsDisplayed()
    }

    @Test fun serviceSwitcherKeepsActionsInsideTheirRowsInDarkModeWithLargeEnglishText() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val original = MobileAppearance.language
        compose.runOnUiThread { MobileAppearance.selectLanguage(context, "en") }
        try {
            val state = MobileUiState().apply {
                devices = listOf(MobileDeviceItem("long", "A long studio service name that wraps", "fixture.invalid", selected = true))
            }
            showServiceSwitcher(state, dark = true, fontScale = 1.5f)
            val row = compose.onNodeWithTag("service-long").fetchSemanticsNode().boundsInRoot
            val button = compose.onNodeWithTag("connect-service-long").assertIsDisplayed().assertIsEnabled().fetchSemanticsNode().boundsInRoot
            val name = compose.onNodeWithTag("service-name-long").fetchSemanticsNode().boundsInRoot
            compose.onNodeWithTag("connect-service-long").assertTextContains("Connect").assertHeightIsAtLeast(48.dp)
            assertTrue(name.right <= button.left && button.right <= row.right && button.bottom <= row.bottom)
            captureSwitcher("service-switcher-dark-large-en.png")
        } finally { compose.runOnUiThread { MobileAppearance.selectLanguage(context, original) } }
    }

    private fun showServiceSwitcher(state: MobileUiState, dark: Boolean = false, fontScale: Float = 1f, onAction: (MobileAction, JSONObject?) -> Unit = { _, _ -> }) {
        compose.setContent {
            androidx.compose.runtime.CompositionLocalProvider(androidx.compose.ui.platform.LocalDensity provides androidx.compose.ui.unit.Density(androidx.compose.ui.platform.LocalDensity.current.density, fontScale)) {
                LexoraTheme(darkTheme = dark) { ServiceSwitcher(state, onAction) {} }
            }
        }
    }

    private fun captureSwitcher(name: String) = captureNode("service-switcher", name)

    private fun captureNode(tag: String, name: String) {
        val bitmap = compose.onNodeWithTag(tag).captureToImage().asAndroidBitmap()
        try {
            File(InstrumentationRegistry.getInstrumentation().targetContext.filesDir, name).outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
        } finally { bitmap.recycle() }
    }

    private fun capture(name: String) {
        compose.mainClock.advanceTimeBy(500)
        compose.waitForIdle()
        val bitmap = compose.onRoot().captureToImage().asAndroidBitmap()
        File(InstrumentationRegistry.getInstrumentation().targetContext.filesDir, name).outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }

    @Test fun compactControlFeedbackStaysInsideItsVisibleSurface() {
        compose.setContent {
            LexoraTheme(darkTheme = false) {
                Box(Modifier.width(360.dp).height(780.dp).background(MaterialTheme.colorScheme.background)) {
                    PaperWorkbench(state(), emptyList(), { _, _ -> }, {}, {})
                }
            }
        }
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        for ((target, surfaceTag) in listOf(
            compose.onNodeWithContentDescription("工作台选项") to "workbench-avatar-surface",
            compose.onNodeWithTag("space-filter") to "space-filter-surface",
            compose.onNodeWithTag("service-selector") to "service-selector-surface",
        )) {
            target.assertHeightIsAtLeast(48.dp)
            val hit = target.fetchSemanticsNode().boundsInRoot
            val face = compose.onNodeWithTag(surfaceTag, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
            val before = compose.onRoot().captureToImage().asAndroidBitmap()
            if (surfaceTag == "service-selector-surface") {
                assertTrue("Service feedback must be shorter than its touch target", face.height < hit.height)
                captureNode("service-selector", "service-selector-rest.png")
            }
            target.performTouchInput { down(center) }
            compose.mainClock.advanceTimeBy(200)
            Thread.sleep(250)
            val pressed = compose.onRoot().captureToImage().asAndroidBitmap()
            File(context.filesDir, "$surfaceTag-pressed.png").outputStream().use { pressed.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
            if (surfaceTag == "service-selector-surface") captureNode("service-selector", "service-selector-pressed.png")
            target.performTouchInput { up() }
            var insideChanges = 0
            var outsideChanges = 0
            for (y in hit.top.toInt() until hit.bottom.toInt()) for (x in hit.left.toInt() until hit.right.toInt()) {
                if (before.getPixel(x, y) == pressed.getPixel(x, y)) continue
                if (face.inflate(1f).contains(androidx.compose.ui.geometry.Offset(x + .5f, y + .5f))) insideChanges++ else outsideChanges++
            }
            assertTrue("$surfaceTag must show press feedback", insideChanges > 0)
            assertEquals("$surfaceTag must not highlight its larger touch target", 0, outsideChanges)
            compose.mainClock.advanceTimeBy(600)
            Thread.sleep(600)
            if (surfaceTag == "service-selector-surface") {
                val released = compose.onRoot().captureToImage().asAndroidBitmap()
                var remainingChanges = 0
                for (y in hit.top.toInt() until hit.bottom.toInt()) for (x in hit.left.toInt() until hit.right.toInt()) {
                    if (before.getPixel(x, y) != released.getPixel(x, y)) remainingChanges++
                }
                assertEquals("Service feedback must clear after release", 0, remainingChanges)
                captureNode("service-selector", "service-selector-released.png")
                released.recycle()
            }
            before.recycle(); pressed.recycle()
        }
    }
}
