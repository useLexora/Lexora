package app.uselexora.mobile

import android.widget.EditText
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.i18n.mobileQuantity
import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.protocol.ProtocolSchemas
import app.uselexora.mobile.ui.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class ConversationInboxInstrumentedTest {
    @get:Rule val compose = createComposeRule()
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val stamp = "2026-01-20T12:00:00.000Z"

    @Test fun regularComposerSeparatesQueueQuestionsFailedAnswersAndApprovals() = exercise(compact = false)
    @Test fun compactComposerSeparatesQueueQuestionsFailedAnswersAndApprovals() = exercise(compact = true)

    private fun exercise(compact: Boolean) {
        val pending = listOf(question("ask-a", "pending"), question("ask-b", "pending"))
        val failedSkip = question("skipped", "cancelled", "failed")
        val failedAnswer = question("reply-b", "answered", "failed")
        val failed = listOf(failedSkip, failedAnswer, question("reply-a", "answered", "failed"))
        val history = listOf(question("delivered", "answered", "delivered"), question("in-flight", "answered", "pending"),
            question("skip-delivered", "cancelled", "delivered"), question("skip-in-flight", "cancelled", "pending"), question("cancelled", "cancelled"))
        val approvals = listOf(approval("review-a", "pending"), approval("review-b", "pending"), approval("review-c", "approved"))
        val state = MobileUiState().apply {
            screen = MobileScreen.Conversation
            topic = "conversation:task:main"
            selectedTask = JSONObject().put("id", "task").put("title", "Task")
            viewBranchId = "main"
            connected = true
            conversationReady = true
            questionsSupported = true
            questions = failed + history + pending
            approvalItems = approvals
            queueItems = listOf("waiting", "paused", "sent", "cancelled", "waiting").mapIndexed { index, value -> queue(index, value) }
        }
        val schemas = ProtocolSchemas(JSONObject(context.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
        for ((method, records) in listOf("chat.queue.list" to state.queueItems, "questions.list" to state.questions, "approvals.list" to state.approvalItems)) {
            assertTrue(method, schemas.response(method, JSONObject().put("items", JSONArray(records)).put("nextCursor", JSONObject.NULL)))
        }
        val actions = mutableListOf<Pair<MobileAction, JSONObject?>>()
        lateinit var input: EditText
        compose.runOnUiThread { input = EditText(context).apply { showSoftInputOnFocus = false } }
        compose.setContent { LexoraTheme { Box(Modifier.width(320.dp).height(if (compact) 216.dp else 640.dp)) {
            MobileShell(state, input, { action, value -> actions.add(action to value) }) { Box(it) }
        } } }
        if (compact) compose.onNodeWithTag("compact-context").assertExists() else compose.onNodeWithTag("compact-context").assertDoesNotExist()
        fun enter(tag: String) = compose.onNodeWithTag(tag).performScrollTo().assertIsDisplayed().performClick()
        fun expectAction(expected: MobileAction, record: JSONObject?) = compose.runOnIdle {
            val (actual, payload) = actions.single()
            assertEquals(expected, actual)
            assertEquals(record?.toString(), payload?.toString())
            actions.clear()
        }
        val queueButton = compose.onNodeWithTag("conversation-queue")
        queueButton.assertTextEquals("${mobileQuantity(R.plurals.inbox_waiting, 2)} · ${mobileQuantity(R.plurals.inbox_paused, 1)}")
        enter("conversation-queue")
        expectAction(MobileAction.TaskQueue, null)

        compose.onNodeWithTag("answer-question").assertTextContains(mobileQuantity(R.plurals.inbox_unanswered, 2))
        enter("answer-question")
        compose.onNodeWithTag("question:ask-a").assertExists()
        compose.onNodeWithTag("question:skipped").assertDoesNotExist()
        compose.onNodeWithTag("question:reply-a").assertDoesNotExist()
        compose.onNodeWithTag("question:delivered").assertDoesNotExist()
        compose.onNodeWithTag("approval:review-a").assertDoesNotExist()
        compose.onNodeWithTag("question:ask-b").performScrollTo().performClick()
        expectAction(MobileAction.AnswerQuestion, pending.last())

        compose.onNodeWithTag("review-undelivered-result").assertTextContains(mobileQuantity(R.plurals.inbox_undelivered, 3))
        enter("review-undelivered-result")
        compose.onNodeWithTag("question:skipped").assertTextContains(mobileText(R.string.mobile_skip_result_not_delivered), substring = true)
        compose.onNodeWithTag("question:reply-b").assertTextContains(mobileText(R.string.mobile_answer_not_delivered), substring = true)
        for (id in listOf("ask-a", "delivered", "in-flight", "skip-delivered", "skip-in-flight", "cancelled")) compose.onNodeWithTag("question:$id").assertDoesNotExist()
        compose.onNodeWithTag("approval:review-a").assertDoesNotExist()
        compose.onNodeWithTag("question:reply-b").performScrollTo().performClick()
        expectAction(MobileAction.AnswerQuestion, failedAnswer)

        compose.onNodeWithTag("review-approval").assertTextContains(mobileQuantity(R.plurals.inbox_approval, 2))
        enter("review-approval")
        compose.onNodeWithTag("question:ask-a").assertDoesNotExist()
        compose.onNodeWithTag("question:reply-a").assertDoesNotExist()
        compose.onNodeWithTag("approval:review-c").assertDoesNotExist()
        compose.onNodeWithTag("approval:review-b").performScrollTo().performClick()
        expectAction(MobileAction.ReviewApproval, approvals[1])

        compose.runOnIdle {
            state.queueItems = state.queueItems.filterNot { it.getString("state") == "waiting" }
            state.questions = history + failedSkip
            state.approvalItems = emptyList()
        }
        queueButton.assertTextEquals(mobileQuantity(R.plurals.inbox_paused, 1))
        compose.onNodeWithTag("answer-question").assertDoesNotExist()
        compose.onNodeWithTag("review-approval").assertDoesNotExist()
        enter("review-undelivered-result")
        expectAction(MobileAction.AnswerQuestion, failedSkip)
        compose.runOnIdle {
            state.queueItems = state.queueItems.filterNot { it.getString("state") == "paused" }
            state.questions = history
        }
        queueButton.assertDoesNotExist()
        compose.onNodeWithTag("review-undelivered-result").assertDoesNotExist()
    }

    private fun scoped(id: String) = JSONObject().put("id", id).put("conversationId", "task").put("branchId", "main").put("createdAt", stamp)

    private fun queue(index: Int, state: String) = scoped("input-$index").put("state", state).put("revision", "1")
        .put("sourceRunId", JSONObject.NULL).put("steerTarget", JSONObject.NULL)
        .put("content", JSONObject().put("kind", "unsupported").put("contentReference", "input-$index").put("version", 1).put("summary", "Queued text").put("readOnly", true))

    private fun question(id: String, status: String, delivery: String? = null): JSONObject {
        val questions = JSONArray()
        val answers = JSONArray()
        for (index in 1..2) {
            questions.put(JSONObject().put("id", "q$index").put("question", "$id question $index").put("kind", "text").put("options", JSONArray()))
            answers.put(JSONObject().put("questionId", "q$index").put("text", "$id saved answer $index").put("selectedOptionIds", JSONArray()))
        }
        return scoped(id).put("runId", "run-$id").put("buddyName", "Buddy").put("status", status).put("questions", questions)
            .put("resolvedAt", if (status == "pending") JSONObject.NULL else stamp)
            .put("response", if (status == "answered") JSONObject().put("answers", answers) else JSONObject.NULL)
            .apply { if (delivery != null) put("delivery", JSONObject().put("state", delivery).put("targetRunId", if (delivery == "delivered") "run-$id" else JSONObject.NULL)) }
    }

    private fun approval(id: String, status: String) = scoped(id).put("runId", "run-$id").put("kind", "tool").put("summary", "$id approval")
        .put("status", status).put("resolvedAt", if (status == "pending") JSONObject.NULL else stamp).put("resolution", JSONObject.NULL).put("review", JSONObject.NULL)
}
