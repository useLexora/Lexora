package app.uselexora.mobile.protocol

import org.json.JSONObject

class ProductProjection {
    private var records = linkedMapOf<String, JSONObject>()
    private var sizes = mutableMapOf<String, Int>()
    private var size = 0L
    @Synchronized fun snapshot(topic: String, items: List<JSONObject>) {
        val next = linkedMapOf<String, JSONObject>()
        for (item in items) next[key(topic, item)] = JSONObject(item.toString())
        val lengths = next.mapValues { it.value.toString().length }.toMutableMap()
        val total = lengths.values.sumOf { it.toLong() }
        bound(next.size, total)
        records = next; sizes = lengths; size = total
    }
    @Synchronized fun apply(topic: String, changes: List<JSONObject>) {
        val next = LinkedHashMap(records)
        val touched = mutableSetOf<String>()
        fun editable(id: String): JSONObject? {
            val value = next[id] ?: return null
            if (touched.add(id)) next[id] = JSONObject(value.toString())
            return next[id]
        }
        for (change in changes) {
            if (topic.startsWith("conversation:")) {
                when (change.getString("kind")) {
                    "upsert" -> { val item = change.getJSONObject("item"); val id = key(topic, item); touched.add(id); next[id] = JSONObject(item.toString()) }
                    "remove" -> { val id = "${change.getString("entity")}:${change.getString("id")}"; touched.add(id); next.remove(id) }
                    "event" -> {
                        val event = change.getJSONObject("event")
                        val run = editable("run:${event.getString("runId")}")?.getJSONObject("value")
                        if (run != null && event.getString("sequence").toBigInteger() > run.optString("lastEventSequence", "0").toBigInteger()) run.put("lastEventSequence", event.getString("sequence"))
                        val detail = event.getJSONObject("detail")
                        if (detail.getString("kind") == "text_delta") {
                            val item = editable("message:${detail.getString("messageId")}") ?: continue
                            val body = item.getJSONObject("value").getJSONObject("body")
                            if (body.optString("kind") == "text" && !body.optBoolean("truncated")) {
                                val text = body.optString("text") + detail.getString("delta")
                                val end = if (text.length > 131072 && Character.isHighSurrogate(text[131071])) 131071 else minOf(text.length, 131072)
                                body.put("text", text.substring(0, end)).put("truncated", body.optBoolean("truncated") || text.length > end)
                            }
                        }
                    }
                    else -> throw ProtocolFailure("SYNC_INVALID")
                }
            } else when (change.getString("kind")) {
                "upsert" -> { val value = change.getJSONObject("value"); val id = value.getString("id"); touched.add(id); next[id] = JSONObject(value.toString()) }
                "remove" -> { val id = change.getString("id"); touched.add(id); next.remove(id) }
                else -> throw ProtocolFailure("SYNC_INVALID")
            }
        }
        val lengths = touched.associateWith { next[it]?.toString()?.length ?: 0 }
        val total = size + lengths.entries.sumOf { (id, length) -> length.toLong() - (sizes[id] ?: 0) }
        bound(next.size, total)
        for ((id, length) in lengths) { if (id in next) sizes[id] = length else sizes.remove(id) }
        records = next; size = total
    }
    @Synchronized fun items(): List<JSONObject> = records.values.map { JSONObject(it.toString()) }
    @Synchronized fun view(): List<JSONObject> = records.values.toList()
    private fun key(topic: String, value: JSONObject): String = if (topic.startsWith("conversation:")) "${value.getString("entity")}:${value.getJSONObject("value").getString("id")}" else value.getString("id")
    private fun bound(count: Int, bytes: Long) { if (count > 10000 || bytes > 8_388_608) throw ProtocolFailure("LIMIT_EXCEEDED") }
}
