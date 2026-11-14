package app.uselexora.mobile.network

import app.uselexora.mobile.protocol.ProtocolFailure
import org.json.JSONObject
import java.nio.ByteBuffer

class ApprovalDocuments(private val connection: MobileConnection) {
    fun get(client: ProductClient, approvalId: String): JSONObject {
        val fresh = client.callValue("approvals.get", JSONObject().put("approvalId", approvalId)) as? JSONObject ?: throw ProtocolFailure("OBJECT_DELETED")
        val review = fresh.optJSONObject("review") ?: return fresh
        if (!review.isNull("document") || review.isNull("resourceId")) return fresh
        val version = review.getString("reviewVersion")
        val resourceId = review.getString("resourceId")
        if (resourceId != "review:$approvalId:$version") throw ProtocolFailure("REVIEW_CHANGED")
        val resource = client.callValue("resources.get", JSONObject().put("resourceId", resourceId)) as? JSONObject ?: throw ProtocolFailure("RESOURCE_UNAVAILABLE")
        if (resource.getString("kind") != "review" || resource.getString("revision") != version) throw ProtocolFailure("REVIEW_CHANGED")
        val size = resource.getString("sizeBytes").toLong()
        if (size !in 1..MAX_BYTES || resource.getString("availability") != "ready") return fresh
        val prepared = client.call("resources.prepare", JSONObject().put("resourceId", resourceId).put("expectedVersion", version))
        if (prepared.getString("resourceId") != resourceId || prepared.getString("sizeBytes").toLong() != size || prepared.getString("mimeType").substringBefore(';') != "application/json") throw ProtocolFailure("REVIEW_CHANGED")
        val digest = prepared.getString("contentVersion")
        val identity = client.identity ?: throw ProtocolFailure("NOT_CONNECTED")
        val bytes = connection.http(identity) { transport, credential ->
            transport.request("/v1/resources/${prepared.getString("downloadId")}", credential = credential, headers = mapOf("If-Match" to "\"$digest\"", "Range" to "bytes=0-${size - 1}")).use { response ->
                if (response.code != 206 || response.header("ETag") != "\"$digest\"" || response.header("Content-Range") != "bytes 0-${size - 1}/$size") throw ProtocolFailure("RESOURCE_UNAVAILABLE")
                val body = response.body ?: throw ProtocolFailure("RESOURCE_UNAVAILABLE")
                if (body.contentLength() != size) throw ProtocolFailure("PROTOCOL_INCOMPATIBLE")
                body.bytes().also { if (it.size.toLong() != size || MobileFiles.hash(it) != digest) throw ProtocolFailure("CONTENT_HASH_MISMATCH") }
            }
        }
        val text = try { Charsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes)).toString() } catch (error: Exception) { throw ProtocolFailure("CONTENT_UNSUPPORTED", error) }
        review.put("document", JSONObject().put("format", "json").put("text", text))
        val latest = client.callValue("approvals.get", JSONObject().put("approvalId", approvalId)) as? JSONObject ?: throw ProtocolFailure("OBJECT_DELETED")
        return attach(latest, fresh)
    }
    companion object {
        const val MAX_BYTES = 2L * 1024 * 1024
        fun attach(latest: JSONObject, reviewed: JSONObject): JSONObject {
            val current = latest.optJSONObject("review") ?: throw ProtocolFailure("REVIEW_CHANGED")
            val previous = reviewed.optJSONObject("review") ?: throw ProtocolFailure("REVIEW_CHANGED")
            if (listOf("id", "runId", "kind").any { latest.optString(it) != reviewed.optString(it) } || current.optString("reviewVersion") != previous.optString("reviewVersion")) throw ProtocolFailure("REVIEW_CHANGED")
            val result = JSONObject(latest.toString())
            if (current.isNull("document") && !previous.isNull("document")) {
                if (current.optString("resourceId") != previous.optString("resourceId")) throw ProtocolFailure("REVIEW_CHANGED")
                result.getJSONObject("review").put("document", JSONObject(previous.getJSONObject("document").toString()))
            }
            return result
        }
    }
}
