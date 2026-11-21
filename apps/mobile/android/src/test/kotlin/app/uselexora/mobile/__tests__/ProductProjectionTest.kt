package app.uselexora.mobile

import app.uselexora.mobile.protocol.ProductProjection
import app.uselexora.mobile.protocol.ProtocolFailure
import app.uselexora.mobile.protocol.conversationWireTopic
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ProductProjectionTest {
    @Test fun turnWindowCapabilityTakesPrecedenceWithoutChangingTheEncodedTarget() {
        val topic = "conversation:task%3Aid:branch"
        assertEquals("conversationTurns:task%3Aid:branch", conversationWireTopic(topic) {
            it == "conversations.getRecentWindow" || it == "conversations.getTurnWindow"
        })
    }

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

    @Test fun positionedTextAdvancesAcrossOldLimitAndNeverJoinsAcrossAGap() {
        val topic = "conversation:t:b"
        val projection = ProductProjection()
        fun range(revision: Int, start: Int, end: Int) = JSONObject().put("revision", revision.toString()).put("start", start).put("end", end).put("total", end)
        val tail = "a" + "😀" + "旧".repeat(16381)
        val oldEnd = 200_000
        val value = JSONObject().put("id", "answer").put("textRange", range(8, oldEnd - tail.length, oldEnd))
            .put("body", JSONObject().put("kind", "text").put("text", tail).put("truncated", false))
        projection.snapshot(topic, listOf(JSONObject().put("entity", "message").put("value", value)))
        fun append(prev: Int, rev: Int, start: Int, text: String) = JSONObject().put("kind", "textAppend").put("messageId", "answer")
            .put("previousRevision", prev.toString()).put("range", range(rev, start, start + text.length)).put("text", text)
        val next = append(8, 10, oldEnd, "更新")
        projection.apply(topic, listOf(next, next))
        fun current() = projection.items().single().getJSONObject("value")
        assertEquals("旧".repeat(16381) + "更新", current().getJSONObject("body").getString("text"))
        assertEquals(oldEnd + 2, current().getJSONObject("textRange").getInt("end"))
        val gap = append(13, 14, oldEnd + 100, "缺口后的正文")
        projection.apply(topic, listOf(gap, next))
        assertEquals("缺口后的正文", current().getJSONObject("body").getString("text"))
        assertEquals(oldEnd + 100, current().getJSONObject("textRange").getInt("start"))
        assertFalse(current().getJSONObject("body").getBoolean("truncated"))
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
        fun text(items: List<JSONObject>) = items.first().getJSONObject("value").getJSONObject("body").getString("text")
        fun sequence(items: List<JSONObject>) = items.last().getJSONObject("value").getString("lastEventSequence")
        val failure = assertThrows(ProtocolFailure::class.java) {
            projection.apply(topic, listOf(delta, JSONObject().put("kind", "invalid")))
        }
        assertEquals("SYNC_INVALID", failure.code)
        assertEquals("原文", text(projection.items()))
        assertEquals("0", sequence(projection.items()))

        projection.apply(topic, listOf(delta))
        assertEquals("原文新增", text(projection.items()))
        assertEquals("1", sequence(projection.items()))
        assertEquals("原文", text(previous))
        assertEquals("0", sequence(previous))
    }

    @Test fun historyWindowWithoutIdRetainsOneTopicScopedMetadataRecord() {
        val projection = ProductProjection()
        val topic = "conversation:task:branch"
        fun metadata(cursor: Any, hasMore: Boolean) = JSONObject().put("entity", "historyWindow").put("value",
            JSONObject().put("conversationId", "task").put("branchId", "branch").put("nextCursor", cursor).put("hasMore", hasMore))
        val message = JSONObject("""{"entity":"message","value":{"id":"message","body":{"kind":"text","text":"原文"}}}""")
        projection.snapshot(topic, listOf(message, metadata("older-page", true), metadata(JSONObject.NULL, false)))
        projection.apply(topic, listOf(JSONObject("""{"kind":"upsert","item":{"entity":"message","value":{"id":"message","body":{"kind":"text","text":"更新"}}}}""")))
        val history = projection.items().single { it.getString("entity") == "historyWindow" }.getJSONObject("value")
        assertSame(JSONObject.NULL, history.get("nextCursor"))
        assertFalse(history.getBoolean("hasMore"))
        assertFalse(history.has("id"))
    }

    @Test fun snapshotCapacityFailurePreservesExistingProjectionAndCanBeRetried() {
        val projection = ProductProjection()
        val topic = "conversation:task:branch"
        val previous = JSONObject("""{"entity":"message","value":{"id":"original"}}""")
        projection.snapshot(topic, listOf(previous))
        val failure = assertThrows(ProtocolFailure::class.java) {
            projection.snapshot(topic, (0..10000).map { JSONObject().put("entity", "message").put("value", JSONObject().put("id", "message-$it")) })
        }
        assertEquals("LIMIT_EXCEEDED", failure.code)
        assertEquals("original", projection.items().single().getJSONObject("value").getString("id"))
        projection.snapshot(topic, listOf(JSONObject("""{"entity":"message","value":{"id":"refreshed"}}""")))
        assertEquals("refreshed", projection.items().single().getJSONObject("value").getString("id"))
    }
}
