package app.uselexora.mobile

import app.uselexora.mobile.storage.OutboxItem
import app.uselexora.mobile.ui.MobileQuestionCommands
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class MobileQuestionCommandsTest {
    private fun command(method: String = "questions.answer", state: String = "unknown", partition: String = "owner", requestId: String = "request") = OutboxItem(
        "original-command", partition, method,
        JSONObject().put("commandId", "original-command").put("dataGeneration", "generation").put("expectedServiceInstanceId", "original-instance")
            .put("intent", JSONObject().put("conversationId", "task").put("branchId", "branch").put("requestId", requestId).apply {
                if (method == "questions.answer") put("answers", JSONArray().put(JSONObject().put("questionId", "choice").put("selectedOptionIds", JSONArray(listOf("first"))).put("text", "Original answer")))
            }),
        state, null,
    )

    @Test fun unresolvedResponseRetainsOriginalCommandEnvelopeInsteadOfNewAnswer() {
        for (state in listOf("prepared", "unknown", "pending", "not_found")) {
            val original = command(state = state)
            val before = original.envelope.toString()
            val recovery = MobileQuestionCommands.pending(listOf(original), "owner", "task", "branch", "request")
            assertSame(original, recovery)
            assertEquals("original-command", recovery!!.id)
            assertEquals("original-instance", recovery.envelope.getString("expectedServiceInstanceId"))
            assertEquals(before, recovery.envelope.toString())
        }
    }

    @Test fun skipAndDeliveryRecoveryCannotBecomeAnotherAnswerOrAnotherQuestion() {
        for (method in listOf("questions.cancel", "questions.retry")) {
            val original = command(method)
            assertSame(original, MobileQuestionCommands.pending(listOf(original), "owner", "task", "branch", "request"))
            assertNull(MobileQuestionCommands.pending(listOf(original), "different-owner", "task", "branch", "request"))
            assertNull(MobileQuestionCommands.pending(listOf(original), "owner", "other-task", "branch", "request"))
            assertNull(MobileQuestionCommands.pending(listOf(original), "owner", "task", "other-branch", "request"))
            assertNull(MobileQuestionCommands.pending(listOf(original), "owner", "task", "branch", "other-request"))
        }
    }

    @Test fun decidedAndUnrelatedCommandsNeverBlockTheQuestion() {
        val items = listOf(command(state = "rejected"), command(state = "accepted"), command(method = "chat.submitInput"), command(partition = "other"), command(requestId = "other"))
        assertNull(MobileQuestionCommands.pending(items, "owner", "task", "branch", "request"))
        val pending = command()
        assertSame(pending, MobileQuestionCommands.pending(items + pending, "owner", "task", "branch", "request"))
    }
}
