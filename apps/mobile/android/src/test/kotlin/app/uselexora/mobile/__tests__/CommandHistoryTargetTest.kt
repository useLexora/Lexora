package app.uselexora.mobile

import app.uselexora.mobile.protocol.ProtocolFailure
import app.uselexora.mobile.session.MobileOperationFailure
import app.uselexora.mobile.storage.OutboxItem
import app.uselexora.mobile.ui.CommandHistoryTarget
import app.uselexora.mobile.ui.MobileFailurePresentation
import app.uselexora.mobile.i18n.mobileText
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CommandHistoryTargetTest {
    init { TestMobileStrings.install() }
    private fun item(scope: String, receipt: JSONObject? = null, intent: JSONObject = JSONObject()) = OutboxItem(
        "original-command", "original-partition", "chat.submitInput", JSONObject().put("intent", intent),
        if (receipt == null) "unknown" else "accepted", receipt, JSONObject().put("scope", scope),
    )

    @Test fun receiptNavigationUsesTheAcceptedBranchButRecoveryKeepsTheOriginalInputScope() {
        val original = "message-edit:task:source-branch:message"
        val record = item(original, JSONObject().put("target", JSONObject().put("conversationId", "task").put("branchId", "accepted-branch")))
        assertEquals(CommandHistoryTarget.Target("task", "accepted-branch"), CommandHistoryTarget.target(record))
        assertEquals(original, CommandHistoryTarget.originalScope(record))
        assertEquals(CommandHistoryTarget.Target("task", "source-branch"), CommandHistoryTarget.target(item(original)))
    }

    @Test fun newTaskWithoutAReceiptDoesNotInventATaskOrUseTheCurrentTask() {
        val record = item("draft:local-input", intent = JSONObject().put("input", JSONObject().put("scope", JSONObject().put("kind", "task").put("draftId", "local-input"))))
        assertNull(CommandHistoryTarget.target(record))
        assertEquals("draft:local-input", CommandHistoryTarget.originalScope(record))
        assertNull(CommandHistoryTarget.target(item("invalid:scope")))
    }

    @Test fun legacyTargetWithoutABranchDoesNotBorrowTheOriginalInputBranch() {
        val record = item("conversation:old-task:old-branch", intent = JSONObject().put("conversationId", "target-task"))
        assertEquals(CommandHistoryTarget.Target("target-task", null), CommandHistoryTarget.target(record))
    }

    @Test fun sourceChangesAndDraftRevisionConflictsHaveDistinctRecoveryGuidance() {
        fun message(code: String) = MobileFailurePresentation.message(MobileOperationFailure.from(ProtocolFailure(code)))
        assertEquals(mobileText(R.string.error_source_changed), message("SOURCE_CHANGED"))
        assertEquals(mobileText(R.string.error_draft_conflict), message("DRAFT_CONFLICT"))
        assertNotEquals(message("SOURCE_CHANGED"), message("DRAFT_CONFLICT"))
        assertEquals(mobileText(R.string.error_local_copy_unavailable), message("LOCAL_COPY_UNAVAILABLE"))
    }
}
