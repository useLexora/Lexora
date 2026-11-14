package app.uselexora.mobile.protocol

import org.json.JSONArray
import org.json.JSONObject
import java.math.BigInteger

class ProtocolFailure(val code: String, cause: Throwable? = null) : Exception(code, cause)

data class ProductIdentity(val serviceId: String, val profileId: String, val dataGeneration: String, val deviceId: String, val serviceInstanceId: String) {
    val partition: String get() = partition(JSONObject().put("serviceId", serviceId).put("profileId", profileId).put("dataGeneration", dataGeneration).put("deviceId", deviceId))
    companion object {
        fun partition(value: JSONObject) = listOf("serviceId", "profileId", "dataGeneration", "deviceId").joinToString("\u0000") { value.getString(it) }
        fun parse(value: JSONObject) = ProductIdentity(value.getString("serviceId"), value.getString("profileId"), value.getString("dataGeneration"), value.getString("deviceId"), value.getString("serviceInstanceId"))
    }
}

object ProductProtocol {
    val supportedContentKinds = JSONArray(listOf("buddy-user-content-v1"))
    fun initialize(version: String) = JSONObject()
        .put("protocol", JSONObject().put("major", 1).put("minMinor", 0).put("maxMinor", 0))
        .put("client", JSONObject().put("kind", "mobile").put("version", version))
        .put("supportedContentKinds", supportedContentKinds)
        .put("supportedReviewKinds", JSONArray(ApprovalReview.supportedKinds))

    fun revision(value: Any?): String {
        if (value !is String || !Regex("0|[1-9][0-9]*").matches(value) || value.length > 19 || BigInteger(value) > BigInteger.valueOf(Long.MAX_VALUE)) throw ProtocolFailure("INVALID_REVISION")
        return value
    }

    fun classifyDelta(epoch: String, sequence: String, frame: JSONObject): String {
        return try {
            val previous = BigInteger(revision(sequence))
            val from = BigInteger(revision(frame.get("fromSeq")))
            val to = BigInteger(revision(frame.get("toSeq")))
            when {
                epoch != frame.getString("syncEpoch") || to <= from -> "resync"
                to <= previous -> "duplicate"
                from == previous -> "apply"
                else -> "resync"
            }
        } catch (_: Exception) { "resync" }
    }

}
