package app.uselexora.mobile

import app.uselexora.mobile.protocol.MobileContentAdapter
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Point
import android.graphics.Rect
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.ResultReceiver
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.util.AtomicFile
import android.provider.Settings
import android.view.accessibility.AccessibilityNodeInfo
import android.view.Choreographer
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.MobileUiTestDriver.click
import app.uselexora.mobile.MobileUiTestDriver.clickTag
import app.uselexora.mobile.MobileUiTestDriver.waitUntil
import app.uselexora.mobile.network.MobileConnection
import app.uselexora.mobile.protocol.ProtocolSchemas
import app.uselexora.mobile.storage.LocalStore
import app.uselexora.mobile.storage.SecretStore
import app.uselexora.mobile.ui.MainActivity
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

@RunWith(AndroidJUnit4::class)
class BranchParallelInstrumentedTest {
    @Test fun localBranchBrowsingAndParallelRunsKeepTheirInputsQuestionsAndQueues() {
        val args = InstrumentationRegistry.getArguments()
        val token = args.getString("branchParallelToken")
        assumeTrue(token?.matches(Regex("[a-f0-9-]{36}")) == true)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val backup = IdentityBackup(context, token!!)
        if (args.getString("branchParallelRestoreOnly") == "true") { backup.restore(); return }
        val config = JSONObject(ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand("cat /data/local/tmp/lexora-branches-$token.json")).bufferedReader().use { it.readText() })
        val schemas = ProtocolSchemas(JSONObject(context.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
        val secrets = SecretStore(context)
        val connection = MobileConnection(context, schemas, BuildConfig.VERSION_NAME, secrets)
        fun marker(stage: String) = File(context.filesDir, "branches-$token-$stage.json")
        fun signal(stage: String, value: JSONObject = JSONObject()) {
            val target = AtomicFile(marker(stage)); val output = target.startWrite()
            try { output.write(value.toString().toByteArray(Charsets.UTF_8)); target.finishWrite(output) }
            catch (error: Exception) { target.failWrite(output); throw error }
        }
        fun awaitSignal(stage: String) = waitUntil(90000) { marker(stage).isFile }
        val conversationId = config.getString("conversationId")
        val branchA = config.getString("branchA")
        val branchB = config.getString("branchB")
        val draftA = "手机 A 独立草稿😀 $token"
        val draftB = "手机 B 独立草稿😀 $token"
        backup.capture()
        try {
            secrets.clear()
            val identity = connection.pair(config.getJSONObject("pairing").toString())
            backup.addPartition(identity.partition)
            connection.renameDevice(connection.activeDeviceId()!!, "分支并行验收服务")
            val client = connection.connect()!!
            try { LocalStore(context).use { store ->
                fun scope(branch: String) = "conversation:$conversationId:$branch"
                fun draft(branch: String) = store.draft(identity.partition, scope(branch))?.value?.optJSONObject("content")?.let(MobileContentAdapter::text).orEmpty()
                fun queue(branch: String): List<JSONObject> {
                    val values = client.call("chat.queue.list", JSONObject().put("conversationId", conversationId).put("branchId", branch)).getJSONArray("items")
                    return (0 until values.length()).map { values.getJSONObject(it) }
                }
                fun run(id: String) = client.call("runs.get", JSONObject().put("runId", id))
                ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java)).use { scenario ->
                    MobileUiTestDriver.awaitConnected()
                    MobileUiTestDriver.openTask(config.getString("title"))
                    fun input(): String { var value = ""; scenario.onActivity { value = it.findViewById<EditText>(MainActivity.INPUT_ID)?.text?.toString().orEmpty() }; return value }
                    fun write(text: String, branch: String? = null) {
                        waitUntil { node { it.isVisibleToUser && it.isEnabled && it.className?.toString() == "android.widget.EditText" } != null }
                        scenario.onActivity { it.findViewById<EditText>(MainActivity.INPUT_ID).setText(text) }
                        waitUntil { input() == text && (branch == null || draft(branch) == text) }
                    }
                    fun select(branch: String, expected: String) {
                        MobileUiTestDriver.selectBranch(branch)
                        waitUntil { tag("branch:$branch") == null && input() == expected && MobileUiTestDriver.exists("任务设置") }
                        assertEquals(0, store.outbox(identity.partition).count { it.method == "conversations.activateBranch" })
                    }
                    select(branchA, "")
                    write("Parallel branch A main $token", branchA)
                    click("发送")
                    waitUntil(30000) { store.outbox(identity.partition).any { it.method == "chat.submitInput" && it.state == "accepted" && it.receipt?.optJSONObject("target")?.optString("branchId") == branchA } }
                    val started = store.outbox(identity.partition).single { it.method == "chat.submitInput" && it.state == "accepted" }.receipt!!.getJSONObject("target")
                    val runA = started.getString("runId")
                    assertEquals(branchA, started.getString("branchId"))
                    signal("phone-started", started)
                    awaitSignal("both-running")
                    waitUntil { MobileUiTestDriver.contains("A 并行输出开始") }
                    assertFalse(MobileUiTestDriver.contains("B 并行输出开始"))
                    write("Queue branch A $token", branchA)
                    MobileUiTestDriver.enqueueInput()
                    waitUntil { queue(branchA).any { MobileContentAdapter.text(it.getJSONObject("content")) == "Queue branch A $token" } }
                    val queuedA = queue(branchA).single { MobileContentAdapter.text(it.getJSONObject("content")) == "Queue branch A $token" }
                    assertTrue(queue(branchB).none { MobileContentAdapter.text(it.getJSONObject("content")) == "Queue branch A $token" })
                    write(draftA, branchA)
                    signal("queue-a", JSONObject().put("queueId", queuedA.getString("id")))
                    awaitSignal("questions-ready")
                    waitUntil { MobileUiTestDriver.contains("只回答分支 A 的问题") }
                    assertFalse(MobileUiTestDriver.contains("只回答分支 B 的问题"))
                    assertEquals(draftA, input())
                    verifyLandscapeInput(scenario, context, token, draftA)
                    assertEquals(draftA, input())
                    assertEquals(draftA, draft(branchA))
                    waitUntil { MobileUiTestDriver.contains("只回答分支 A 的问题") }
                    select(branchB, "")
                    waitUntil { MobileUiTestDriver.contains("只回答分支 B 的问题") }
                    assertFalse(MobileUiTestDriver.contains("只回答分支 A 的问题"))
                    write(draftB, branchB)
                    select(branchA, draftA)
                    waitUntil { MobileUiTestDriver.contains("只回答分支 A 的问题") }
                    scenario.recreate()
                    waitUntil { input() == draftA && MobileUiTestDriver.contains("只回答分支 A 的问题") }
                    assertEquals(draftB, draft(branchB))
                    capture(context, token, "isolated")
                    signal("views-isolated", JSONObject().put("draftA", draftA).put("draftB", draftB).put("recreated", true))
                    awaitSignal("answer-a")
                    clickTag("answer-question")
                    waitUntil { MobileUiTestDriver.exists("提交回答") }
                    waitUntil {
                        node { it.isVisibleToUser && it.className?.toString() == "android.widget.EditText" }?.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, "分支 A 的回答 $token") }) == true
                    }
                    click("提交回答")
                    waitUntil { store.outbox(identity.partition).any { it.method == "questions.answer" && it.state == "accepted" } }
                    assertEquals(draftA, input())
                    signal("answered-a")
                    awaitSignal("stop-a")
                    MobileUiTestDriver.stopRunningReply()
                    waitUntil(30000) { run(runA).getString("status") == "cancelled" && queue(branchA).any { it.getString("id") == queuedA.getString("id") && it.getString("state") == "paused" } }
                    assertEquals(draftA, input())
                    signal("stopped-a", JSONObject().put("runId", runA).put("queueId", queuedA.getString("id")))
                    awaitSignal("edit-a")
                    MobileUiTestDriver.longClick("Parallel baseline A $token"); click("编辑")
                    waitUntil { input() == "Parallel baseline A $token" }
                    write("Parallel edited A $token")
                    click("发送")
                    waitUntil(30000) { store.outbox(identity.partition).any { it.method == "chat.submitInput" && it.envelope.getJSONObject("intent").optString("operation") == "edit" && it.state == "accepted" } }
                    val edited = store.outbox(identity.partition).single { it.method == "chat.submitInput" && it.envelope.getJSONObject("intent").optString("operation") == "edit" }.receipt!!.getJSONObject("target")
                    assertNotEquals(branchA, edited.getString("branchId")); assertNotEquals(branchB, edited.getString("branchId"))
                    waitUntil(30000) { MobileUiTestDriver.contains("编辑 A 的新分支结果") }
                    assertEquals(draftA, draft(branchA)); assertEquals(draftB, draft(branchB))
                    signal("edited-a", edited)
                    awaitSignal("restore-a")
                    select(branchA, draftA)
                    scenario.moveToState(Lifecycle.State.CREATED)
                    scenario.moveToState(Lifecycle.State.RESUMED)
                    MobileUiTestDriver.openTaskSettings(); MobileUiTestDriver.awaitConnected(); MobileUiTestDriver.returnToConversation()
                    waitUntil { input() == draftA && MobileUiTestDriver.exists("任务设置") }
                    assertFalse(MobileUiTestDriver.contains("B 并行完成"))
                    signal("reconnected-a", JSONObject().put("draft", input()))
                    awaitSignal("b-finished")
                    assertEquals(draftA, input())
                    assertFalse(MobileUiTestDriver.contains("B 并行完成"))
                    select(branchB, draftB)
                    waitUntil { MobileUiTestDriver.contains("B 队列独立完成") }
                    assertFalse(MobileUiTestDriver.contains("A 已收到本分支回答"))
                    select(branchA, draftA)
                    assertEquals("paused", queue(branchA).single { it.getString("id") == queuedA.getString("id") }.getString("state"))
                    assertEquals(0, store.outbox(identity.partition).count { it.method == "conversations.activateBranch" })
                    capture(context, token, "restored")
                    signal("done", JSONObject().put("conversationId", conversationId).put("branchA", branchA).put("branchB", branchB).put("runA", runA).put("editedBranch", edited.getString("branchId")).put("independentDrafts", true).put("recreated", true).put("reconnected", true).put("noGlobalActivation", true).put("landscapeImeVisible", true))
                }
            } } finally { client.close() }
        } finally {
            backup.restore()
            if (marker("done").isFile) signal("done", JSONObject(marker("done").readText()).put("originalIdentityRestored", true))
        }
    }

    private fun tag(id: String) = node { it.isVisibleToUser && (it.viewIdResourceName == id || it.viewIdResourceName?.endsWith(":id/$id") == true) }
    private fun node(predicate: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo? {
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        InstrumentationRegistry.getInstrumentation().uiAutomation.rootInActiveWindow?.let(queue::addLast)
        var count = 0
        while (queue.isNotEmpty() && count++ < 10000) {
            val current = queue.removeFirst()
            if (predicate(current)) return current
            repeat(current.childCount) { current.getChild(it)?.let(queue::addLast) }
        }
        return null
    }
    private data class InputGeometry(
        val viewIdentity: Int,
        val nativeBounds: Rect,
        val accessibilityBounds: Rect?,
        val tagBounds: Rect?,
        val globalVisibleBounds: Rect,
        val localVisibleBounds: Rect,
        val frame: Rect,
        val rootHeight: Int,
        val displaySize: Point,
        val imeVisible: Boolean?,
        val imeBottom: Int?,
        val systemBarsBottom: Int?,
        val orientation: Int,
        val density: Float,
        val lineHeight: Int,
        val attached: Boolean,
        val enabled: Boolean,
        val shown: Boolean,
        val layoutRequested: Boolean,
        val windowFocused: Boolean,
        val focused: Boolean,
        val editorActive: Boolean,
        val textMatches: Boolean,
    ) {
        val aligned get() = accessibilityBounds == nativeBounds && (tagBounds == null || (tagBounds.contains(nativeBounds) && nativeBounds.contains(tagBounds.centerX(), tagBounds.centerY()))) && !nativeBounds.isEmpty
        val fullyVisible get() = aligned && localVisibleBounds.width() == nativeBounds.width() && localVisibleBounds.height() == nativeBounds.height() && nativeBounds.height() >= lineHeight && frame.contains(nativeBounds)
        val readyForTouch get() = attached && enabled && shown && !layoutRequested && windowFocused && textMatches && fullyVisible
        val imeShown get() = imeVisible == true
        fun sameGeometry(other: InputGeometry) = viewIdentity == other.viewIdentity && orientation == other.orientation && nativeBounds == other.nativeBounds && accessibilityBounds == other.accessibilityBounds && tagBounds == other.tagBounds && frame == other.frame
        fun json(stage: String) = JSONObject().put("stage", stage).put("uptime", SystemClock.uptimeMillis()).put("viewIdentity", viewIdentity)
            .put("nativeScreenBounds", nativeBounds.toShortString()).put("accessibilityScreenBounds", accessibilityBounds?.toShortString())
            .put("inputTagScreenBounds", tagBounds?.toShortString()).put("globalVisibleBounds", globalVisibleBounds.toShortString()).put("localVisibleBounds", localVisibleBounds.toShortString())
            .put("windowVisibleFrame", frame.toShortString()).put("rootHeight", rootHeight).put("displayWidth", displaySize.x).put("displayHeight", displaySize.y)
            .put("imeInsetsVisible", imeVisible).put("imeInsetsBottom", imeBottom).put("systemBarsInsetsBottom", systemBarsBottom).put("orientation", orientation).put("density", density)
            .put("attached", attached).put("enabled", enabled).put("shown", shown).put("layoutRequested", layoutRequested)
            .put("windowFocused", windowFocused).put("focused", focused).put("editorActive", editorActive).put("textMatches", textMatches)
            .put("aligned", aligned).put("fullyVisible", fullyVisible).put("imeShown", imeShown)
    }

    private fun inputGeometry(scenario: ActivityScenario<MainActivity>, expected: String): InputGeometry? {
        val accessible = node { it.isVisibleToUser && it.isEnabled && it.className?.toString() == "android.widget.EditText" && it.text?.toString() == expected }
        val accessibleBounds = accessible?.let { Rect().apply { it.getBoundsInScreen(this) } }
        val tagBounds = tag("input")?.let { Rect().apply { it.getBoundsInScreen(this) } }
        var geometry: InputGeometry? = null
        scenario.onActivity { activity ->
            val input = activity.findViewById<EditText>(MainActivity.INPUT_ID) ?: return@onActivity
            val position = IntArray(2).also(input::getLocationOnScreen)
            val global = Rect().also { input.getGlobalVisibleRect(it) }
            val local = Rect().also { input.getLocalVisibleRect(it) }
            val frame = Rect().also { activity.window.decorView.getWindowVisibleDisplayFrame(it) }
            val manager = activity.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
            val insets = ViewCompat.getRootWindowInsets(input)
            val display = Point().also { activity.windowManager.defaultDisplay.getRealSize(it) }
            geometry = InputGeometry(System.identityHashCode(input), Rect(position[0], position[1], position[0] + input.width, position[1] + input.height), accessibleBounds, tagBounds, global, local, frame,
                activity.window.decorView.rootView.height, display, insets?.isVisible(WindowInsetsCompat.Type.ime()), insets?.getInsets(WindowInsetsCompat.Type.ime())?.bottom, insets?.getInsets(WindowInsetsCompat.Type.systemBars())?.bottom,
                activity.resources.configuration.orientation, activity.resources.displayMetrics.density, input.lineHeight,
                input.isAttachedToWindow && input.windowToken != null, input.isEnabled, input.isShown, input.isLayoutRequested,
                activity.hasWindowFocus(), input.hasFocus(), manager.isActive(input), input.text.toString() == expected)
        }
        return geometry
    }

    private fun awaitAnimationFrames(count: Int) {
        val frames = CountDownLatch(count)
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            Choreographer.getInstance().postFrameCallback(object : Choreographer.FrameCallback {
                override fun doFrame(time: Long) { frames.countDown(); if (frames.count > 0) Choreographer.getInstance().postFrameCallback(this) }
            })
        }
        assertTrue("Branch UI did not advance animation frames", frames.await(3, TimeUnit.SECONDS))
    }

    private fun inputMethodSystemState(): JSONObject = runCatching {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val states = JSONArray()
        val fields = Regex("""\b(mShowRequested|mInputShown|mShowExplicitlyRequested|mShowForced|mAccessibilityRequestingNoSoftKeyboard|mImeWindowVis|mInputViewShown|mWindowVisible|mIsFullscreen|mShowInputFlags|mShowInputRequested|mSystemReady|mHardwareKeyboardAvailable)=(true|false|0x[0-9a-fA-F]+|[0-9]+)""")
        ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand("dumpsys -t 2 input_method")).bufferedReader().use { reader ->
            reader.lineSequence().take(1000).forEach { line ->
                if (states.length() < 96) fields.findAll(line).forEach { field -> states.put(JSONObject().put("name", field.groupValues[1]).put("value", field.groupValues[2])) }
            }
        }
        JSONObject().put("states", states)
            .put("accessibilitySoftKeyboardMode", Settings.Secure.getInt(context.contentResolver, "accessibility_soft_keyboard_mode", 0))
            .put("showImeWithHardKeyboard", Settings.Secure.getInt(context.contentResolver, "show_ime_with_hard_keyboard", 0))
            .put("uiAutomationServiceFlags", instrumentation.uiAutomation.serviceInfo.flags)
    }.getOrElse { JSONObject().put("diagnosticError", it.javaClass.simpleName) }

    private fun verifyLandscapeInput(scenario: ActivityScenario<MainActivity>, context: Context, token: String, expected: String) {
        var previous = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        var previousConfiguration = Configuration.ORIENTATION_PORTRAIT
        val diagnostics = JSONArray()
        var touch: JSONObject? = null
        val requestAccepted = AtomicReference<Boolean?>(null)
        val requestResult = AtomicReference<Int?>(null)
        val imeContext = JSONObject()
        var systemBefore: JSONObject? = null
        var systemAfter: JSONObject? = null
        scenario.onActivity { previous = it.requestedOrientation; previousConfiguration = it.resources.configuration.orientation }
        fun sample(stage: String): InputGeometry? = inputGeometry(scenario, expected).also { geometry ->
            if (diagnostics.length() >= 40) diagnostics.remove(0)
            diagnostics.put(geometry?.json(stage) ?: JSONObject().put("stage", stage).put("editorMissing", true))
        }
        fun ready(orientation: Int): Boolean {
            var matches = false
            scenario.onActivity { activity -> matches = activity.resources.configuration.orientation == orientation && activity.findViewById<EditText>(MainActivity.INPUT_ID)?.text?.toString() == expected }
            return matches
        }
        try {
            scenario.onActivity { it.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE }
            waitUntil(30000) { ready(Configuration.ORIENTATION_LANDSCAPE) }
            var touchBounds: Rect? = null
            waitUntil {
                val before = sample("before-stable-frames") ?: return@waitUntil false
                if (!before.readyForTouch) return@waitUntil false
                awaitAnimationFrames(2)
                val after = sample("after-stable-frames") ?: return@waitUntil false
                if (!after.readyForTouch || !before.sameGeometry(after)) return@waitUntil false
                touchBounds = Rect(after.tagBounds ?: after.accessibilityBounds!!)
                touch = after.json("touch").put("x", touchBounds!!.exactCenterX()).put("y", touchBounds!!.exactCenterY())
                true
            }
            val bounds = touchBounds ?: error("Stable landscape editor geometry unavailable")
            val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
            ParcelFileDescriptor.AutoCloseInputStream(automation.executeShellCommand("input touchscreen tap ${bounds.centerX()} ${bounds.centerY()}")).use { it.readBytes() }
            waitUntil {
                sample("after-touch")?.let { it.attached && it.windowFocused && it.focused && it.editorActive } == true
            }
            systemBefore = inputMethodSystemState()
            val requested = CountDownLatch(1)
            val receiver = object : ResultReceiver(Handler(Looper.getMainLooper())) {
                override fun onReceiveResult(resultCode: Int, resultData: Bundle?) { requestResult.set(resultCode) }
            }
            scenario.onActivity { activity ->
                val input = activity.findViewById<EditText>(MainActivity.INPUT_ID)
                val manager = activity.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
                imeContext.put("imeOptions", input.imeOptions).put("inputType", input.inputType).put("showSoftInputOnFocus", input.showSoftInputOnFocus)
                    .put("windowSoftInputMode", activity.window.attributes.softInputMode).put("configurationKeyboard", activity.resources.configuration.keyboard)
                    .put("hardKeyboardHidden", activity.resources.configuration.hardKeyboardHidden).put("managerFullscreenBefore", manager.isFullscreenMode)
                input.postOnAnimation {
                    requestAccepted.set(manager.showSoftInput(input, 0, receiver))
                    requested.countDown()
                }
            }
            assertTrue("Landscape input method request did not reach the focused editor", requested.await(3, TimeUnit.SECONDS))
            waitUntil(20000) {
                val current = sample("ime-visible") ?: return@waitUntil false
                val send = tag("send")?.let { Rect().apply { it.getBoundsInScreen(this) } }
                current.imeShown && current.fullyVisible && current.textMatches && send != null && !send.isEmpty && current.frame.contains(send)
            }
            systemAfter = inputMethodSystemState()
            capture(context, token, "landscape-ime")
            scenario.onActivity { activity ->
                val input = activity.findViewById<EditText>(MainActivity.INPUT_ID)
                (activity.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(input.windowToken, 0)
                activity.requestedOrientation = if (previousConfiguration == Configuration.ORIENTATION_LANDSCAPE) ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE else ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
            }
            waitUntil(30000) { ready(previousConfiguration) }
        } finally {
            val resultName = when (requestResult.get()) {
                InputMethodManager.RESULT_SHOWN -> "shown"
                InputMethodManager.RESULT_UNCHANGED_SHOWN -> "unchanged_shown"
                InputMethodManager.RESULT_HIDDEN -> "hidden"
                InputMethodManager.RESULT_UNCHANGED_HIDDEN -> "unchanged_hidden"
                null -> "no_callback"
                else -> "unknown"
            }
            val request = JSONObject().put("flags", 0).put("accepted", requestAccepted.get()).put("resultCode", requestResult.get()).put("result", resultName).put("editor", imeContext)
            File(context.filesDir, "branches-$token-landscape-touch.json").writeText(JSONObject().put("touch", touch).put("samples", diagnostics)
                .put("showInputRequest", request).put("systemBefore", systemBefore).put("systemAfter", systemAfter ?: inputMethodSystemState()).toString(2))
            scenario.onActivity { it.requestedOrientation = previous }
        }
    }

    private fun capture(context: Context, token: String, stage: String) {
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        automation.waitForIdle(250, 5000)
        awaitAnimationFrames(2)
        val image = automation.takeScreenshot() ?: error("Screenshot unavailable")
        try { File(context.filesDir, "branches-$token-$stage.png").outputStream().use { assertTrue(image.compress(Bitmap.CompressFormat.PNG, 100, it)) } }
        finally { image.recycle() }
    }
    private class IdentityBackup(private val context: Context, token: String) {
        private val identity = AtomicFile(File(context.noBackupFilesDir, "device-identity.bin"))
        private val bytesFile = File(context.noBackupFilesDir, "branch-parallel-$token-identity.bin")
        private val manifest = AtomicFile(File(context.noBackupFilesDir, "branch-parallel-$token-identity.json"))
        fun capture() {
            check(!bytesFile.exists() && !manifest.baseFile.exists())
            val present = identity.baseFile.exists() || File("${identity.baseFile.path}.bak").exists()
            val bytes = if (present) identity.readFully() else ByteArray(0)
            FileOutputStream(bytesFile).use { it.write(bytes); it.fd.sync() }
            save(JSONObject().put("present", present).put("sha256", digest(bytes)).put("partitions", JSONArray()))
        }
        fun addPartition(partition: String) { val value = JSONObject(String(manifest.readFully(), Charsets.UTF_8)); value.getJSONArray("partitions").put(partition); save(value) }
        fun restore() {
            if (!manifest.baseFile.exists() && !File("${manifest.baseFile.path}.bak").exists()) return
            val value = JSONObject(String(manifest.readFully(), Charsets.UTF_8)); val bytes = bytesFile.readBytes()
            check(digest(bytes) == value.getString("sha256"))
            if (value.getBoolean("present")) {
                val output = identity.startWrite()
                try { output.write(bytes); identity.finishWrite(output) } catch (error: Exception) { identity.failWrite(output); throw error }
                assertArrayEquals(bytes, identity.readFully())
            } else identity.delete()
            val partitions = value.getJSONArray("partitions")
            LocalStore(context).use { store ->
                val navigation = context.getSharedPreferences("mobile-navigation", Context.MODE_PRIVATE).edit()
                repeat(partitions.length()) { index ->
                    val partition = partitions.getString(index)
                    require(partition.isNotBlank() && partition != "unpaired-local")
                    store.writableDatabase.delete("drafts", "partition=?", arrayOf(partition)); store.writableDatabase.delete("outbox", "partition=?", arrayOf(partition)); navigation.remove(partition)
                    context.getSharedPreferences("mobile-navigation", Context.MODE_PRIVATE).all.keys.filter { it.startsWith("view-branch:$partition:") }.forEach(navigation::remove)
                }
                check(navigation.commit())
                val answers = context.getSharedPreferences("question-inputs", Context.MODE_PRIVATE)
                val edit = answers.edit(); val prefixes = (0 until partitions.length()).map { partitions.getString(it) + ":" }
                answers.all.keys.filter { key -> prefixes.any { key.startsWith(it) } }.forEach(edit::remove)
                check(edit.commit())
            }
        }
        private fun save(value: JSONObject) { val output = manifest.startWrite(); try { output.write(value.toString().toByteArray(Charsets.UTF_8)); manifest.finishWrite(output) } catch (error: Exception) { manifest.failWrite(output); throw error } }
        private fun digest(value: ByteArray) = MessageDigest.getInstance("SHA-256").digest(value).joinToString("") { "%02x".format(it) }
    }
}
