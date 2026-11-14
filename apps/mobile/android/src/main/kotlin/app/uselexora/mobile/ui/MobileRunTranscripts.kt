package app.uselexora.mobile.ui

import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.R
import android.os.Handler
import android.os.Looper
import app.uselexora.mobile.network.ProductClient
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

internal class MobileRunTranscripts(private val changed: (Map<String, JSONObject>) -> Unit) {
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    @Volatile private var generation = 0
    private var owner = ""
    private var client: ProductClient? = null
    private var runs = emptyList<JSONObject>()
    private val requested = mutableSetOf<String>()
    private val loading = mutableSetOf<String>()
    private val records = mutableMapOf<String, JSONObject>()
    fun update(scope: String, connection: ProductClient?, values: List<JSONObject>) {
        if (scope != owner || connection !== client) {
            generation++; loading.clear()
            if (scope != owner) { requested.clear(); records.clear(); changed(emptyMap()) }
            owner = scope; client = connection
        }
        runs = values
        requested.toList().forEach { load(it) }
    }
    fun request(runId: String, retry: Boolean = false) {
        if (requested.add(runId) || retry) load(runId, retry = retry)
    }
    private fun load(runId: String, retry: Boolean = false) {
        val connection = client ?: return
        val run = runs.firstOrNull { it.optString("id") == runId && it.optString("executionKind", "root") == "root" } ?: return
        val through = run.optString("lastEventSequence", "0")
        val prior = records[runId]
        val after = prior?.optString("sequence", "0") ?: "0"
        if (runId in loading || (!retry && prior?.has("error") == true) || (prior?.optBoolean("loaded") == true && after.toBigInteger() >= through.toBigInteger())) return
        if (!connection.supports("runs.listTranscriptEvents")) return
        val captured = generation
        loading.add(runId)
        worker.execute {
            if (captured != generation) return@execute
            val result = runCatching {
                val previous = prior?.optJSONArray("events")
                val events = JSONArray()
                if (previous != null) for (index in 0 until previous.length()) events.put(previous.get(index))
                var size = prior?.optLong("encodedSize") ?: 0L
                var cursor: String? = null
                do {
                    if (captured != generation) return@execute
                    val page = connection.call("runs.listTranscriptEvents", JSONObject().put("runId", runId).put("afterSequence", after).put("throughSequence", through).put("cursor", cursor ?: JSONObject.NULL).put("limit", 100))
                    val items = page.getJSONArray("items")
                    for (index in 0 until items.length()) {
                        val event = items.getJSONObject(index)
                        size += event.toString().length
                        events.put(event)
                    }
                    check(events.length() <= 20000 && size <= 8_388_608) { mobileText(R.string.mobile_execution_history_is_too_long_to_load_completely) }
                    cursor = page.optString("nextCursor").takeUnless { it.isBlank() || it == "null" }
                } while (cursor != null)
                JSONObject().put("events", events).put("sequence", through).put("loaded", true).put("encodedSize", size)
            }
            main.post {
                if (captured != generation) return@post
                loading.remove(runId)
                records[runId] = result.getOrElse { JSONObject(prior?.toString() ?: "{}").put("error", mobileText(R.string.mobile_execution_history_unavailable_tap_to_retry)) }
                changed(records.toMap())
                if (result.isSuccess) load(runId)
            }
        }
    }
    fun close() { generation++; worker.shutdownNow() }
}
