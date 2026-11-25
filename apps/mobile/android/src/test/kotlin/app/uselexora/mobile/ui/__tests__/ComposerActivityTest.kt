package app.uselexora.mobile.ui

import app.uselexora.mobile.TestMobileStrings
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ComposerActivityTest {
    init { TestMobileStrings.install() }

    private fun run(id: String, status: String = "running", branch: String = "branch", kind: String = "root") = JSONObject()
        .put("id", id).put("conversationId", "task").put("branchId", branch).put("executionKind", kind)
        .put("generation", "1").put("status", status).put("purpose", "chat")
    private fun message(id: String, revision: String) = JSONObject().put("role", "assistant").put("runId", id)
        .put("textRange", JSONObject().put("revision", revision).put("total", 10))
    private fun group(id: String) = JSONObject().put("runId", id).put("runningCount", 1).put("runningReasoningCount", 1)

    @Test fun onlyLiveScopedPublicRunsSupplyPhaseFactsIndependentlyOfTheReadingWindow() {
        val window = ConversationReadingWindow()
        val live = ConversationPage(listOf(message("live", "3"), message("saved", "s:version")), listOf(group("live")),
            listOf(run("live"), run("saved", kind = "actor_child"), run("done", "completed"), run("other", branch = "other"), run("private", kind = "npc_child"), run("maintenance", kind = "maintenance")))
        window.project(1, live)
        window.pin(ConversationPage(runs = listOf(run("old"))))
        val sources = projectComposerRuns(window.latest, "task", "branch")
        assertEquals(listOf("live", "saved"), sources.map { it.id })
        assertEquals(ComposerRun("live", "1", "running", true, true, true), sources[0])
        assertFalse(sources[1].replying)
        window.project(2, live.copy(runs = listOf(run("live", "failed"))))
        assertTrue(projectComposerRuns(window.latest, "task", "branch").isEmpty())
    }

    @Test fun givesActionablePublicWaitsPriorityAndDropsStaleOrOfflineActivity() {
        val state = MobileUiState().apply {
            screen = MobileScreen.Conversation; connected = true; conversationReady = true
            composerSources = projectComposerRuns(ConversationPage(runs = listOf(run("active"), run("child", kind = "actor_child"))), "task", "branch")
        }
        assertEquals("active", state.composerSource?.id)
        state.approvalItems = listOf(JSONObject().put("runId", "child").put("status", "pending"))
        assertEquals("child", state.composerSource?.id)
        assertTrue(state.composerSource!!.awaitingApproval)
        state.approvalItems = emptyList(); state.questionsSupported = true
        state.questions = listOf(JSONObject().put("runId", "child").put("status", "pending"))
        assertTrue(state.composerSource!!.awaitingAnswer)
        state.questions = emptyList(); state.stoppingRunId = "active"
        assertTrue(state.composerSource!!.stopping)
        state.readingCached = true
        assertNull(state.composerSource)
        state.readingCached = false; state.conversationReady = false
        assertNull(state.composerSource)
        state.conversationReady = true; state.connected = false
        assertNull(state.composerSource)
    }
}
