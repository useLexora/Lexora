package app.uselexora.mobile

import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.protocol.ProductResumePoint
import app.uselexora.mobile.protocol.ProductSubscription
import app.uselexora.mobile.protocol.ProtocolSchemas
import app.uselexora.mobile.protocol.SubscriptionProjection
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ConversationResumeInstrumentedTest {
    @Test fun resumesOnlyAtTheAppliedCursorAndAcceptsCurrentSnapshotInsteadOfBacklog() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val schemas = ProtocolSchemas(JSONObject(context.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
        val requests = CopyOnWriteArrayList<JSONObject>()
        val publications = CopyOnWriteArrayList<Pair<Long, String>>()
        val serials = AtomicLong()
        val canonical = "conversation:t:b"
        val expectedSequences = listOf("7", "8", "99")
        val settled = expectedSequences.map { CompletableFuture<Unit>() }

        SyntheticProductService(schemas, listOf("conversations.getTurnWindow")) { call ->
            val index = call.connection - 1
            val params = call.params
            when (call.method) {
                "sync.subscribe" -> {
                    requests.add(params)
                    val id = params.getString("subscriptionId")
                    if (index == 1) {
                        call.reply(JSONObject().put("subscriptionId", id).put("mode", "resume").put("cursor", cursor("7")))
                        call.notify("sync.delta", JSONObject().put("subscriptionId", id).put("syncEpoch", "live")
                            .put("fromSeq", "7").put("toSeq", "8").put("changes", JSONArray().put(JSONObject().put("kind", "upsert").put("item", item("patched")))))
                    } else {
                        call.reply(JSONObject().put("subscriptionId", id).put("mode", "snapshot").put("cursor", cursor(expectedSequences[index]))
                            .put("complete", true).put("nextCursor", JSONObject.NULL)
                            .put("items", JSONArray().put(item(if (index == 0) "original" else "final"))))
                    }
                }
                "sync.ack" -> {
                    call.reply(JSONObject().put("acknowledged", true))
                    if (params.getString("seq") == expectedSequences[index]) settled[index].complete(Unit)
                }
                "sync.unsubscribe" -> call.reply(JSONObject().put("unsubscribed", true))
                else -> settled[index].completeExceptionally(AssertionError("Unexpected request: ${call.method}"))
            }
        }.use { service ->
            var seed: ProductResumePoint? = null
            for ((index, expectedSequence) in expectedSequences.withIndex()) {
                val client = service.connect()
                try {
                    val view = SubscriptionProjection(requireNotNull(client.identity), serials::incrementAndGet, publish = { topic, values, serial ->
                        assertEquals(canonical, topic)
                        publications.add(serial to values.single().getJSONObject("value").getJSONObject("body").getString("text"))
                    }).apply { inherit(seed) }
                    val subscription = ProductSubscription(client, schemas, view, state = {}, failure = { settled[index].completeExceptionally(it) })
                    try {
                        subscription.subscribe(canonical)
                        settled[index].get(8, TimeUnit.SECONDS)
                        val checkpoint = requireNotNull(subscription.checkpoint)
                        assertEquals(expectedSequence, checkpoint.sequence)
                        seed = checkpoint
                    } finally { subscription.close() }
                } finally { client.close() }
            }
        }

        assertEquals(3, requests.size)
        assertFalse(requests[0].has("base"))
        assertEquals(listOf("7", "8"), requests.drop(1).map { it.getJSONObject("base").getString("seq") })
        assertTrue(requests.drop(1).all { it.getJSONObject("base").getString("syncEpoch") == "live" })
        assertTrue(requests.all { it.getString("topic") == "conversationTurns:t:b" })
        val frames = publications.toList()
        val distinctFrames = frames.filterIndexed { index, frame -> index == 0 || frame != frames[index - 1] }
        assertEquals(listOf("original", "patched", "final"), distinctFrames.map { it.second })
        assertEquals(distinctFrames[0].first, distinctFrames[1].first)
        assertNotEquals(distinctFrames[1].first, distinctFrames[2].first)
    }

    private fun cursor(seq: String) = JSONObject().put("syncEpoch", "live").put("seq", seq)

    private fun item(text: String) = JSONObject().put("entity", "message").put("value", JSONObject()
        .put("id", "reply").put("conversationId", "t").put("branchId", "b").put("runId", "run")
        .put("role", "assistant").put("createdAt", "2026-10-01T00:00:00.000Z").put("resources", JSONArray())
        .put("body", JSONObject().put("kind", "text").put("text", text).put("interrupted", false).put("truncated", false)))
}
