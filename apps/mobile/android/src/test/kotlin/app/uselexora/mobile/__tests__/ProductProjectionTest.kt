package app.uselexora.mobile

import app.uselexora.mobile.protocol.ProductProjection
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ProductProjectionTest {
    @Test fun truncatedStreamingPrefixNeverSplitsEmojiOrAppendsAfterMissingText() {
        val projection = ProductProjection()
        val topic = "conversation:task:branch"
        val body = JSONObject().put("kind", "text").put("text", "中".repeat(131071)).put("truncated", false)
        val message = JSONObject().put("entity", "message").put("value", JSONObject().put("id", "answer").put("body", body))
        projection.snapshot(topic, listOf(message))
        fun delta(text: String) = JSONObject().put("kind", "event").put("event", JSONObject().put("runId", "run").put("sequence", "1").put("detail", JSONObject().put("kind", "text_delta").put("messageId", "answer").put("delta", text)))
        projection.apply(topic, listOf(delta("😀尾部"), delta("不能拼在缺失片段之后")))
        val result = projection.items().single().getJSONObject("value").getJSONObject("body")
        assertEquals("中".repeat(131071), result.getString("text"))
        assertTrue(result.getBoolean("truncated"))
        body.put("text", "最终正文").put("truncated", false)
        projection.apply(topic, listOf(JSONObject().put("kind", "upsert").put("item", message)))
        assertEquals("最终正文", projection.items().single().getJSONObject("value").getJSONObject("body").getString("text"))
    }

    @Test fun streamingPreservesPublishedSnapshotsAndRollsBackAllChangesOnFailure() {
        val projection = ProductProjection()
        val topic = "conversation:task:branch"
        projection.snapshot(topic, listOf(
            JSONObject("""{"entity":"message","value":{"id":"message","body":{"kind":"text","text":"原文"}}}"""),
            JSONObject("""{"entity":"run","value":{"id":"run","lastEventSequence":"0"}}"""),
        ))
        val previous = projection.view()
        val delta = JSONObject("""{"kind":"event","event":{"runId":"run","sequence":"1","detail":{"kind":"text_delta","messageId":"message","delta":"新增"}}}""")
        assertTrue(runCatching { projection.apply(topic, listOf(delta, JSONObject().put("kind", "invalid"))) }.isFailure)
        assertEquals("原文", projection.items().first().getJSONObject("value").getJSONObject("body").getString("text"))
        projection.apply(topic, listOf(delta))
        assertEquals("原文", previous.first().getJSONObject("value").getJSONObject("body").getString("text"))
        assertEquals("0", previous.last().getJSONObject("value").getString("lastEventSequence"))
        assertEquals("原文新增", projection.items().first().getJSONObject("value").getJSONObject("body").getString("text"))
    }

}
