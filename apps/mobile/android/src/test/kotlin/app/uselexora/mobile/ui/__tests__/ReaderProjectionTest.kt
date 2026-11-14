package app.uselexora.mobile.ui

import app.uselexora.mobile.protocol.ProtocolSchemas
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class ReaderProjectionTest {
    init { app.uselexora.mobile.TestMobileStrings.install() }
    private val appearance = JSONObject(File("build/generated/reader/reader/appearance.json").readText())
    private val schemas = ProtocolSchemas(JSONObject(File("build/generated/protocol/reader-protocol.json").readText()))
    private fun message(id: String, text: String) = JSONObject().put("id", id).put("role", "assistant")
        .put("body", JSONObject().put("kind", "text").put("text", text))
    private fun snapshot(topic: String, messages: List<JSONObject>, transcripts: Map<String, JSONObject> = emptyMap()) =
        ReaderSnapshot(messages, topic, emptyMap(), emptyList(), transcripts, false, 1f, "zh", null, emptyMap())
    private fun encode(projection: ReaderProjection, value: ReaderSnapshot): JSONObject = projection.encode(value,
        { appearance.getJSONObject("light") }, { appearance.getJSONObject("typography") })
        .also { assertTrue(it.toString(), schemas.valid(it, schemas.document.getJSONObject("update"))) }
    @Test fun changedMessagesAreIncrementalAndRestartResendsFullSnapshot() {
        val projection = ReaderProjection()
        val first = message("a", "first")
        val second = message("b", "second")
        val initial = encode(projection, snapshot("one", listOf(first, second)))
        assertTrue(initial.getBoolean("reset")); assertEquals(2, initial.getJSONArray("entries").length())
        val unchanged = encode(projection, snapshot("one", listOf(first, second)))
        assertEquals(0, unchanged.getJSONArray("entries").length()); assertFalse(unchanged.has("order"))
        val changed = encode(projection, snapshot("one", listOf(first, message("b", "updated"))))
        assertEquals("b", changed.getJSONArray("entries").getJSONObject(0).getString("id"))
        projection.reset()
        assertEquals(2, encode(projection, snapshot("one", listOf(first, second))).getJSONArray("entries").length())
        val other = encode(projection, snapshot("two", listOf(first)))
        assertTrue(other.getBoolean("reset")); assertEquals(1, other.getJSONArray("order").length())
    }
    @Test fun transcriptAppendRequiresUnchangedPrefixAndTopic() {
        val projection = ReaderProjection()
        fun event(sequence: Int) = JSONObject().put("runId", "run").put("sequence", sequence).put("type", "run.started").put("createdAt", "2026-11-11T05:00:00Z").put("payload", JSONObject())
        fun transcript(vararg events: JSONObject) = mapOf("run" to JSONObject().put("events", JSONArray(events.toList())).put("loaded", true))
        val first = event(1)
        encode(projection, snapshot("one", emptyList(), transcript(first)))
        val appended = encode(projection, snapshot("one", emptyList(), transcript(first, event(2))))
            .getJSONObject("transcripts").getJSONObject("run")
        assertTrue(appended.getBoolean("append")); assertEquals(1, appended.getJSONArray("events").length())
        val replaced = encode(projection, snapshot("one", emptyList(), transcript(event(1))))
            .getJSONObject("transcripts").getJSONObject("run")
        assertFalse(replaced.getBoolean("append")); assertEquals(1, replaced.getJSONArray("events").length())
    }
}
