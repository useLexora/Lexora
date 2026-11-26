package app.uselexora.mobile.notifications

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TaskNotificationPolicyTest {
    private val now = 1_700_000_000_000L
    private val open = NotificationPreferences()

    private fun task(
        id: String = "c1",
        activity: String = "idle",
        unread: Boolean = false,
        status: String? = "completed",
        run: String? = "r1",
        questions: Int = 0,
        branch: String? = "b1",
        at: Long = now,
    ) = TaskNotificationState(id, "Task", activity, unread, status, run, branch, questions, "preview", at)

    private fun evaluate(
        previous: List<TaskNotificationState>? = emptyList(),
        current: List<TaskNotificationState>,
        preferences: NotificationPreferences = open,
        quiet: Boolean = false,
        nowMillis: Long = now,
        muted: Set<String> = emptySet(),
        notified: Set<String> = emptySet(),
    ) = TaskNotificationPolicy.evaluate(previous, current, preferences, quiet, nowMillis, muted, notified)

    @Test fun baselineIgnoresStaleStateButAnnouncesRecentUnreadResults() {
        assertTrue(evaluate(null, listOf(task(activity = "awaiting_approval", unread = true, questions = 1, at = now - 30 * 60_000))).isEmpty())
        val recent = evaluate(null, listOf(task(unread = true, at = now - 60_000)))
        assertEquals(1, recent.size)
        val show = recent.single() as TaskNotificationEvent.Show
        assertEquals(TaskNotificationKind.Result, show.kind)
        assertEquals("r1", show.runId)
        assertEquals("b1", show.branchId)
    }

    @Test fun approvalIsAnnouncedOnEntryAndRetractedWhenResolved() {
        val entered = evaluate(listOf(task(activity = "running")), listOf(task(activity = "awaiting_approval")))
        assertEquals(TaskNotificationKind.Approval, (entered.single() as TaskNotificationEvent.Show).kind)
        assertTrue(evaluate(listOf(task(activity = "awaiting_approval")), listOf(task(activity = "awaiting_approval"))).isEmpty())
        val left = evaluate(listOf(task(activity = "awaiting_approval")), listOf(task(activity = "running")))
        assertEquals(TaskNotificationEvent.Retract("c1", TaskNotificationKind.Approval), left.single())
    }

    @Test fun questionTracksThePendingCount() {
        val asked = evaluate(listOf(task(questions = 0)), listOf(task(questions = 2)))
        assertEquals(TaskNotificationKind.Question, (asked.single() as TaskNotificationEvent.Show).kind)
        val answered = evaluate(listOf(task(questions = 2)), listOf(task(questions = 0)))
        assertEquals(TaskNotificationEvent.Retract("c1", TaskNotificationKind.Question), answered.single())
    }

    @Test fun quietHoursSuppressNewAlertsButStillRetractResolvedOnes() {
        assertTrue(evaluate(listOf(task(activity = "running")), listOf(task(activity = "awaiting_approval")), quiet = true).isEmpty())
        val resolved = evaluate(listOf(task(activity = "awaiting_approval")), listOf(task(activity = "idle")), quiet = true)
        assertEquals(TaskNotificationEvent.Retract("c1", TaskNotificationKind.Approval), resolved.single())
    }

    @Test fun resultIsAnnouncedOncePerRunAndAgainForANewRun() {
        val first = evaluate(listOf(task(unread = false, activity = "running")), listOf(task(unread = true)))
        assertEquals(TaskNotificationKind.Result, (first.single() as TaskNotificationEvent.Show).kind)
        val notified = setOf(TaskNotificationPolicy.runKey("c1", "r1"))
        assertTrue(evaluate(listOf(task(unread = true)), listOf(task(unread = true)), notified = notified).isEmpty())
        val second = evaluate(listOf(task(unread = true, run = "r1")), listOf(task(unread = true, run = "r2")), notified = notified)
        assertEquals("r2", (second.single() as TaskNotificationEvent.Show).runId)
    }

    @Test fun readingAResultOrLosingTheTaskRetractsIt() {
        assertEquals(TaskNotificationEvent.Retract("c1", TaskNotificationKind.Result),
            evaluate(listOf(task(unread = true)), listOf(task(unread = false))).single())
        val removed = evaluate(listOf(task(unread = true, activity = "awaiting_approval", questions = 1)), emptyList())
        assertEquals(setOf(
            TaskNotificationEvent.Retract("c1", TaskNotificationKind.Approval),
            TaskNotificationEvent.Retract("c1", TaskNotificationKind.Question),
            TaskNotificationEvent.Retract("c1", TaskNotificationKind.Result),
        ), removed.toSet())
    }

    @Test fun categoryTogglesAndMutingKeepSilent() {
        assertTrue(evaluate(listOf(task(activity = "running")), listOf(task(activity = "awaiting_approval")),
            preferences = open.copy(approvals = false)).isEmpty())
        assertTrue(evaluate(listOf(task(unread = false, activity = "running")), listOf(task(unread = true, status = "failed")),
            preferences = open.copy(failed = false)).isEmpty())
        assertTrue(evaluate(listOf(task(activity = "running")), listOf(task(activity = "awaiting_approval")),
            muted = setOf("c1")).isEmpty())
    }

    @Test fun failedResultsUseTheFailureToggleAndKeepTheirRunIdentity() {
        val failed = evaluate(listOf(task(unread = false, activity = "running")), listOf(task(unread = true, status = "failed", run = "r9")))
        val show = failed.single() as TaskNotificationEvent.Show
        assertTrue(show.failed)
        assertEquals("r9", show.runId)
        assertTrue(evaluate(listOf(task(unread = true, status = "failed", run = "r9")), listOf(task(unread = true, status = "failed", run = "r9")),
            notified = setOf(TaskNotificationPolicy.runKey("c1", "r9"))).isEmpty())
    }

    @Test fun unrelatedTasksStayIndependent() {
        val events = evaluate(
            listOf(task(id = "c1", activity = "running"), task(id = "c2", unread = false, activity = "running")),
            listOf(task(id = "c1", activity = "awaiting_approval"), task(id = "c2", unread = true)),
        )
        assertEquals(setOf(
            TaskNotificationKind.Approval to "c1",
            TaskNotificationKind.Result to "c2",
        ), events.map { it.kind to it.conversationId }.toSet())
    }
}
