package app.uselexora.mobile.ui

import android.os.Handler
import android.os.Looper
import app.uselexora.mobile.protocol.ProtocolFailure
import java.util.concurrent.CompletableFuture
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONObject

internal class ReaderStepDetailReads {
    private val main = Handler(Looper.getMainLooper())
    private val pending = mutableMapOf<String, AtomicBoolean>()
    private var inFlight = 0

    fun stop(id: String) { pending.remove(id)?.set(false) }
    fun reset() { pending.values.forEach { it.set(false) }; pending.clear() }

    fun read(action: JSONObject, turn: ReaderTurnContext, valid: () -> Boolean, reply: (JSONObject) -> Unit) {
        val stepId = action.getString("stepId")
        val response = JSONObject().put("type", "step-detail").put("topic", action.getString("topic"))
            .put("stepId", stepId).put("requestId", action.getString("requestId"))
        fun finish(result: JSONObject?, error: String?) {
            reply(response.put("result", result ?: JSONObject.NULL).put("error", error ?: JSONObject.NULL))
        }
        if (!valid()) { finish(null, "unavailable"); return }
        val method = "conversations.readActivityStepDetail"
        val target = turn.target
        val client = turn.client
        if (inFlight >= 4 || target == null || client?.isConnected != true) { finish(null, "retry"); return }
        if (!client.supports(method)) { finish(null, "unsupported"); return }
        val params = target.params().put("runId", action.getString("runId")).put("groupId", action.getString("groupId")).put("stepId", stepId)
        (action.opt("knownRevision") as? String)?.let { params.put("knownRevision", it) }
        val id = action.getString("requestId")
        if (id in pending) return
        val live = AtomicBoolean(true)
        pending[id] = live; inFlight++
        CompletableFuture.supplyAsync { runCatching { if (live.get()) client.call(method, params) else null } }.thenAccept { result -> main.post {
            inFlight--
            if (!live.get()) return@post
            pending.remove(id)
            if (!valid()) { finish(null, "retry"); return@post }
            val value = result.getOrNull()?.takeIf { it.optString("stepId") == stepId }
            val code = (result.exceptionOrNull() as? ProtocolFailure)?.code
            finish(value, if (value != null) null else if (code in setOf("OBJECT_DELETED", "RESOURCE_UNAVAILABLE")) "unavailable" else "retry")
        } }
    }
}
