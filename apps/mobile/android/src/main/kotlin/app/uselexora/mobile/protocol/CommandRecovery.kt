package app.uselexora.mobile.protocol

import app.uselexora.mobile.storage.OutboxItem
import org.json.JSONObject

enum class CommandRecovery { Complete, CheckReceipt, RetryOriginal, ReviewApproval, ReviewTask;
    companion object {
        fun forItem(item: OutboxItem, serviceInstanceId: String?): CommandRecovery = when {
            item.state in setOf("accepted", "rejected") -> Complete
            item.state != "not_found" -> CheckReceipt
            item.method == "approvals.resolve" -> ReviewApproval
            item.envelope.optString("expectedServiceInstanceId") != serviceInstanceId -> ReviewTask
            else -> RetryOriginal
        }
    }
}

object CommandReceipt {
    fun requireAccepted(receipt: JSONObject): JSONObject {
        when (receipt.optString("decision")) {
            "accepted" -> return receipt
            "rejected" -> throw ProtocolFailure(receipt.optString("errorCode", "COMMAND_REJECTED"))
            else -> throw ProtocolFailure("PROTOCOL_INCOMPATIBLE")
        }
    }
}
