package app.uselexora.mobile

import android.content.Intent
import android.os.Bundle
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.network.PinnedTransport
import app.uselexora.mobile.network.ProductClient
import app.uselexora.mobile.protocol.ProtocolSchemas
import app.uselexora.mobile.storage.LocalStore
import app.uselexora.mobile.ui.MainActivity
import app.uselexora.mobile.ui.MobileQuestions
import okhttp3.CertificatePinner
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class QuestionRetryInstrumentedTest {
    @Test fun rejectedAnswerStaysEditableInTheOriginalPanel() = failureFlow("questions.answer", false)
    @Test fun unknownAnswerReconcilesTheOriginalCommandWithoutAnotherSubmission() = failureFlow("questions.answer", true)
    @Test fun rejectedSkipReturnsToThePreservedAnswerPanel() = failureFlow("questions.cancel", false)
    @Test fun failedDeliveryRetryStaysInTheResponsePanel() = failureFlow("questions.retry", false)

    @Test fun failedSkipRetryUsesOriginalRequestWithoutAnswers() = failureFlow("questions.retry", false, skipped = true)

    private fun failureFlow(method: String, unknown: Boolean, skipped: Boolean = false) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val schemas = ProtocolSchemas(JSONObject(context.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
        val worker = Executors.newSingleThreadExecutor()
        val errors = CopyOnWriteArrayList<Throwable>()
        Fixture(schemas, method, unknown, skipped).use { fixture -> LocalStore(context).use { store ->
            val partition = fixture.client.identity!!.partition
            val key = "$partition:request"
            val preferences = context.getSharedPreferences("question-inputs", android.content.Context.MODE_PRIVATE)
            try {
                ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("fixture", true)).use { scenario ->
                    lateinit var questions: MobileQuestions
                    val ready = AtomicBoolean(false)
                    scenario.onActivity { activity ->
                        questions = MobileQuestions(activity, store, schemas,
                            work = { action -> worker.execute { try { action() } catch (error: Throwable) { errors.add(error) } } },
                            ui = { action -> activity.runOnUiThread { action() } },
                            changed = { if (it.isNotEmpty()) ready.set(true) }, notice = {})
                        questions.bind(fixture.client, "task", "branch")
                    }
                    MobileUiTestDriver.waitUntil { ready.get() }
                    scenario.onActivity { questions.show(fixture.question) }
                    if (method != "questions.retry") setAnswer("Keep this local response")
                    fun clickAction() {
                        when (method) {
                            "questions.cancel" -> {
                                MobileUiTestDriver.click(mobileText(R.string.question_decline))
                                MobileUiTestDriver.waitUntil { MobileUiTestDriver.exists(mobileText(R.string.question_skip_title)) }
                                MobileUiTestDriver.click(mobileText(R.string.question_skip))
                            }
                            "questions.retry" -> MobileUiTestDriver.click(mobileText(R.string.question_retry))
                            else -> MobileUiTestDriver.click(mobileText(R.string.question_submit))
                        }
                    }
                    clickAction()
                    val failure = mobileText(if (unknown) R.string.error_command_result_unknown else R.string.error_question_answer_invalid)
                    MobileUiTestDriver.waitUntil { MobileUiTestDriver.contains(failure) }
                    assertTrue(MobileUiTestDriver.contains("Choose the scope"))
                    if (method == "questions.retry") {
                        val resultLabel = mobileText(if (skipped) R.string.question_skip_response else R.string.question_answers)
                        assertTrue(MobileUiTestDriver.contains(mobileText(R.string.question_response_saved, resultLabel)))
                        assertEquals(!skipped, MobileUiTestDriver.contains("Saved answer"))
                    } else {
                        assertTrue(MobileUiTestDriver.contains("Keep this local response"))
                        assertTrue(preferences.getString(key, null)!!.contains("Keep this local response"))
                    }
                    assertEquals(1, fixture.requests.size)
                    if (unknown) {
                        assertFalse(MobileUiTestDriver.enabled(mobileText(R.string.question_decline)))
                        MobileUiTestDriver.click(mobileText(R.string.question_check_status))
                    } else clickAction()
                    MobileUiTestDriver.waitUntil { store.outbox(partition).any { it.state == "accepted" } }
                    MobileUiTestDriver.waitUntil { !MobileUiTestDriver.contains("Choose the scope") }
                    assertEquals(if (unknown) 1 else 2, fixture.requests.size)
                    val records = store.outbox(partition)
                    assertEquals(if (unknown) 1 else 2, records.size)
                    assertTrue(records.all { it.method == method })
                    if (method == "questions.retry") for (request in fixture.requests) {
                        val intent = request.getJSONObject("intent")
                        assertEquals(fixture.question.getString("id"), intent.getString("requestId"))
                        assertEquals(fixture.question.getString("conversationId"), intent.getString("conversationId"))
                        assertEquals(fixture.question.getString("branchId"), intent.getString("branchId"))
                        assertFalse(intent.has("answers"))
                    }
                    if (unknown) assertEquals(fixture.requests.single().getString("commandId"), records.single().id)
                    if (method == "questions.answer") assertNull(preferences.getString(key, null))
                    if (method == "questions.cancel") assertTrue(preferences.getString(key, null)!!.contains("Keep this local response"))
                    scenario.onActivity { questions.close() }
                }
            } finally {
                worker.shutdown()
                assertTrue(worker.awaitTermination(10, TimeUnit.SECONDS))
                store.writableDatabase.delete("outbox", "partition=?", arrayOf(partition))
                preferences.edit().remove(key).commit()
            }
            assertTrue(errors.toString(), errors.isEmpty())
        } }
    }

    private fun setAnswer(value: String) {
        MobileUiTestDriver.waitUntil {
            val root = InstrumentationRegistry.getInstrumentation().uiAutomation.rootInActiveWindow ?: return@waitUntil false
            val queue = ArrayDeque<AccessibilityNodeInfo>().apply { add(root) }
            while (queue.isNotEmpty()) {
                val node = queue.removeFirst()
                if (node.isVisibleToUser && node.className?.toString() == "android.widget.EditText") {
                    return@waitUntil node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value) })
                }
                repeat(node.childCount) { node.getChild(it)?.let(queue::addLast) }
            }
            false
        }
    }

    private class Fixture(private val schemas: ProtocolSchemas, private val method: String, private val unknown: Boolean, skipped: Boolean) : AutoCloseable {
        private val token = UUID.randomUUID().toString()
        private val certificate = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        private val server = MockWebServer().apply {
            useHttps(HandshakeCertificates.Builder().heldCertificate(certificate).build().sslSocketFactory(), false)
            start()
        }
        val requests = CopyOnWriteArrayList<JSONObject>()
        private var decided: JSONObject? = null
        val question = JSONObject().put("id", "request").put("conversationId", "task").put("branchId", "branch").put("runId", "run")
            .put("buddyName", "Fixture").put("status", when {
                skipped -> "cancelled"
                method == "questions.retry" -> "answered"
                else -> "pending"
            })
            .put("createdAt", "2026-11-09T00:00:00.000Z").put("resolvedAt", if (method == "questions.retry") "2026-11-09T00:00:01.000Z" else JSONObject.NULL)
            .put("questions", JSONArray().put(JSONObject().put("id", "scope").put("question", "Choose the scope").put("kind", "text").put("options", JSONArray())))
            .put("response", if (method == "questions.retry" && !skipped) JSONObject().put("answers", JSONArray().put(JSONObject().put("questionId", "scope").put("selectedOptionIds", JSONArray()).put("text", "Saved answer"))) else JSONObject.NULL)
            .apply { if (method == "questions.retry") put("delivery", JSONObject().put("state", "failed").put("targetRunId", JSONObject.NULL)) }
        val client: ProductClient
        init {
            server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, reason) }
                override fun onMessage(socket: WebSocket, text: String) {
                    val request = JSONObject(text)
                    val operation = request.getString("method")
                    val params = request.getJSONObject("params")
                    fun reply(value: JSONObject) { socket.send(JSONObject().put("jsonrpc", "2.0").put("id", request.getString("id")).put("result", value).toString()) }
                    when (operation) {
                        "initialize" -> reply(identity())
                        "sync.subscribe" -> reply(JSONObject().put("subscriptionId", params.getString("subscriptionId")).put("mode", "snapshot")
                            .put("cursor", JSONObject().put("syncEpoch", "epoch").put("seq", "0")).put("items", JSONArray().put(question)).put("complete", true).put("nextCursor", JSONObject.NULL))
                        "sync.ack" -> reply(JSONObject().put("acknowledged", true))
                        "sync.unsubscribe" -> reply(JSONObject().put("unsubscribed", true))
                        "commands.get" -> reply(JSONObject().put("lookup", "decided").put("receipt", decided!!))
                        method -> {
                            requests.add(JSONObject(params.toString()))
                            val receipt = JSONObject().put("commandId", params.getString("commandId")).put("dataGeneration", params.getString("dataGeneration"))
                                .put("method", method).put("decision", if (unknown || requests.size > 1) "accepted" else "rejected").put("decidedAt", Instant.now().toString())
                                .put("target", JSONObject().put("conversationId", "task").put("branchId", "branch").put("questionId", "request")).put("result", JSONObject())
                            if (!unknown && requests.size == 1) receipt.put("errorCode", "QUESTION_ANSWER_INVALID")
                            decided = receipt
                            if (unknown && requests.size == 1) socket.send(JSONObject().put("jsonrpc", "2.0").put("id", request.getString("id"))
                                .put("error", JSONObject().put("code", -32000).put("message", "Response unavailable").put("data", JSONObject().put("code", "SERVICE_UNREACHABLE"))).toString())
                            else reply(JSONObject().put("receipt", receipt))
                        }
                        else -> throw AssertionError("Unexpected method: $operation")
                    }
                }
            }))
            client = ProductClient(PinnedTransport(server.url("/").toString().trimEnd('/'), CertificatePinner.pin(certificate.certificate)), "fixture-only", schemas)
            client.connect(BuildConfig.VERSION_NAME)
        }
        private fun identity(): JSONObject {
            val result = JSONObject()
            for (key in listOf("serviceId", "profileId", "dataGeneration", "serviceInstanceId", "connectionId", "clientSessionId", "deviceId")) result.put(key, "$token-$key")
            val limits = JSONObject()
            val properties = schemas.document.getJSONObject("initialize").getJSONObject("output").getJSONObject("properties").getJSONObject("limits").getJSONObject("properties")
            for (key in properties.keys()) limits.put(key, properties.getJSONObject(key).get("const"))
            return result.put("protocol", JSONObject().put("major", 1).put("minor", 1)).put("phase", "ready").put("serverTime", Instant.now().toString())
                .put("capabilities", JSONArray(listOf("questions.list", "questions.answer", "questions.cancel", "questions.retry"))).put("limits", limits)
        }
        override fun close() { client.close(); server.close() }
    }
}
