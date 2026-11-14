package app.uselexora.mobile

import app.uselexora.mobile.session.*
import app.uselexora.mobile.protocol.*
import app.uselexora.mobile.storage.OutboxItem
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.Executor

class MobileOperationsTest {
    init { app.uselexora.mobile.TestMobileStrings.install() }
    @Test fun staleFailuresCannotOverwriteTheNextVisitOrIdentity() {
        val background = ArrayDeque<Runnable>()
        val main = ArrayDeque<() -> Unit>()
        val original = MobileOperationOwner("one", "conversation:task:branch", "conversation:task:branch", 1, 1)
        var current = original
        var visible: String? = "new page"
        val operations = MobileOperations(Executor { background.add(it) }, { current }, { main.add(it) }, { true }) { visible = it.code }
        for (next in listOf(original.copy(partition = "two"), original.copy(visit = 2), original.copy(view = "Devices"), original.copy(connectionGeneration = 2), original.copy(inputScope = "message-edit:task:branch:message"))) {
            current = original
            operations.execute { throw ProtocolFailure("SOURCE_CHANGED") }
            background.removeFirst().run()
            current = next
            main.removeFirst().invoke()
            assertEquals("new page", visible)
        }
        current = original
        operations.execute { throw ProtocolFailure("COMMAND_RESULT_UNKNOWN") }
        background.removeFirst().run(); main.removeFirst().invoke()
        assertEquals("COMMAND_RESULT_UNKNOWN", visible)
    }
    @Test fun ownerChangesDoNotCancelDurableSettlementAndClosedViewsDoNotReceiveErrors() {
        val background = ArrayDeque<Runnable>()
        val main = ArrayDeque<() -> Unit>()
        var current = MobileOperationOwner("one", "taskIndex", "draft:one", 1, 1)
        var alive = true
        var settled = false
        var visible = "unchanged"
        val operations = MobileOperations(Executor { background.add(it) }, { current }, { main.add(it) }, { alive }) { visible = it.code.orEmpty() }
        operations.execute { settled = true; throw ProtocolFailure("LOCAL_STORAGE_FAILED") }
        current = current.copy(partition = "two")
        background.removeFirst().run(); alive = false; main.removeFirst().invoke()
        assertTrue(settled)
        assertEquals("unchanged", visible)
    }
    @Test fun unknownDeliveryRemainsUnknownEvenWhenItsCauseLooksRetryable() {
        val failure = MobileOperationFailure.from(ProtocolFailure("COMMAND_RESULT_UNKNOWN", java.io.IOException("offline")))
        assertEquals("COMMAND_RESULT_UNKNOWN", failure.code)
        assertEquals("SERVICE_UNREACHABLE", MobileOperationFailure.from(java.io.IOException("offline")).code)
    }
    @Test fun receiptRecoveryNeverConflatesNewCommandsAndOriginalRetries() {
        fun item(state: String, method: String = "chat.submitInput", instance: String = "original") = OutboxItem("command", "partition", method,
            JSONObject().put("expectedServiceInstanceId", instance), state, null)
        assertEquals(CommandRecovery.CheckReceipt, CommandRecovery.forItem(item("unknown"), "original"))
        assertEquals(CommandRecovery.CheckReceipt, CommandRecovery.forItem(item("prepared"), "original"))
        assertEquals(CommandRecovery.RetryOriginal, CommandRecovery.forItem(item("not_found"), "original"))
        assertEquals(CommandRecovery.ReviewTask, CommandRecovery.forItem(item("not_found"), "restarted"))
        assertEquals(CommandRecovery.ReviewApproval, CommandRecovery.forItem(item("not_found", "approvals.resolve"), "restarted"))
        for (state in listOf("accepted", "rejected")) assertEquals(CommandRecovery.Complete, CommandRecovery.forItem(item(state), "restarted"))
    }
}
