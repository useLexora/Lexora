package app.uselexora.mobile.ui

import app.uselexora.mobile.TestMobileStrings
import app.uselexora.mobile.protocol.MobileMessageDetail
import app.uselexora.mobile.protocol.ProtocolSchemas
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class ReaderProjectionTest {
    init { TestMobileStrings.install() }

    private val appearance = JSONObject(File("build/generated/reader/reader/appearance.json").readText())
    private val schemas = ProtocolSchemas(JSONObject(File("build/generated/protocol/reader-protocol.json").readText()))
    private fun message(id: String, text: String) = JSONObject().put("id", id).put("role", "assistant")
        .put("body", JSONObject().put("kind", "text").put("text", text))
    private fun snapshot(topic: String, messages: List<JSONObject>, transcripts: Map<String, JSONObject> = emptyMap()) =
        ReaderSnapshot(messages, topic, emptyMap(), emptyList(), transcripts, false, 1f, "zh", null, emptyMap())
    private fun encode(projection: ReaderProjection, value: ReaderSnapshot,
        photoState: (JSONObject) -> ReaderPhotoState = { ReaderPhotoState("unavailable") }): JSONObject = projection.encode(value,
        { appearance.getJSONObject("light") }, { appearance.getJSONObject("typography") }, photoState)
        .also { assertTrue(it.toString(), schemas.valid(it, schemas.document.getJSONObject("update"))) }

    private fun order(update: JSONObject): List<String> = update.getJSONArray("order").let { array ->
        (0 until array.length()).map(array::getString)
    }

    @Test fun onlyLiveRangedTextIsReplyingInATurnWindow() {
        val run = JSONObject("""{"id":"run","buddyId":"actor","approvalPolicy":"manual","branchId":"branch","completedAt":null,"conversationId":"task","errorCode":null,"executionProfile":"read_only","generation":"1","lastEventSequence":"10","modelId":"model","providerId":"provider","purpose":"chat","reasoningLevel":null,"startedAt":"2026-11-11T05:00:00Z","status":"running","triggeringMessageId":"user"}""")
        fun reply(revision: String?) = message("reply", "Text").put("runId", "run").apply {
            if (revision != null) put("textRange", JSONObject().put("start", 0).put("end", 4).put("total", 4).put("revision", revision))
        }
        fun isFinal(revision: String?, compact: Boolean = true, history: Boolean = false): Boolean {
            val data = snapshot("topic", listOf(reply(revision))).copy(runs = listOf(run), turn = ReaderTurnContext(enabled = compact), hasLaterMessages = history)
            return encode(ReaderProjection(), data).getJSONArray("entries").getJSONObject(0).getJSONArray("messages").getJSONObject(0).getBoolean("final")
        }
        assertFalse(isFinal("10"))
        assertTrue(isFinal(null))
        assertTrue(isFinal("s:" + "a".repeat(64)))
        assertTrue(isFinal("10", history = true))
        assertFalse(isFinal(null, compact = false))
    }

    @Test fun changedMessagesAreIncrementalAndRestartResendsFullSnapshot() {
        val projection = ReaderProjection()
        val first = message("a", "first")
        val second = message("b", "second")
        val initial = encode(projection, snapshot("one", listOf(first, second)))
        assertTrue(initial.getBoolean("reset"))
        assertEquals(listOf("a", "b"), order(initial))
        val changed = encode(projection, snapshot("one", listOf(first, message("b", "updated"))))
        val entries = changed.getJSONArray("entries")
        assertEquals(1, entries.length())
        assertEquals("b", entries.getJSONObject(0).getString("id"))
        assertFalse(changed.has("order"))

        projection.reset()
        assertEquals(2, encode(projection, snapshot("one", listOf(first, second))).getJSONArray("entries").length())
        val other = encode(projection, snapshot("two", listOf(first)))
        assertTrue(other.getBoolean("reset"))
        assertEquals(listOf("a"), order(other))
    }
    @Test fun foldedGroupsKeepNarrativeBoundariesAndOnlyPublishTheRequestedDetail() {
        val date = "2026-01-02T01:00:00Z"
        fun group(id: String, after: String, count: Int) = JSONObject().put("id", id).put("afterMessageId", after)
            .put("createdAt", date).put("runId", "run").put("toolCount", count).put("failedCount", 1)
            .put("runningCount", 0).put("interruptedCount", 0).put("activeToolName", JSONObject.NULL)
            .put("reasoningCount", 0).put("runningReasoningCount", 0).put("interruptedReasoningCount", 0)
            .put("counts", JSONArray().put(JSONObject().put("category", "command").put("count", count)))
        val input = message("input", "Create the package").put("role", "user")
        val progress = message("progress", "Retrying the build").put("runId", "run")
        val answer = message("answer", "The package is ready").put("runId", "run")
        val base = snapshot("task:branch", listOf(input, progress, answer)).copy(turn = ReaderTurnContext(enabled = true,
            groups = listOf(group("second", "progress", 1), group("first", "input", 200)), historyAvailable = true))
        val projection = ReaderProjection()
        val folded = encode(projection, base)
        assertEquals(listOf("input", "first", "progress", "second", "answer"), order(folded))
        assertTrue(folded.getBoolean("turnWindow"))
        assertTrue(folded.getJSONObject("history").getBoolean("available"))
        assertFalse(folded.toString().contains("\"steps\""))
        val step = JSONObject().put("id", "73").put("toolName", "bash").put("status", "failed").put("messageId", "tool-answer")
        val page = ReaderStepPage().append(JSONObject().put("items", JSONArray().put(step)).put("nextCursor", "next"))
        assertFalse(page.accepts(null))
        assertFalse(page.accepts("wrong-page"))
        assertTrue(page.accepts("next"))
        val details = mapOf("tool-answer" to MobileMessageDetail(text = "Step 73 failed"))
        val expanded = encode(projection, base.copy(stepPages = mapOf("first" to page.wire(details))))
        val entries = expanded.getJSONArray("entries")
        assertEquals(1, entries.length())
        val published = entries.getJSONObject(0)
        assertEquals("first", published.getString("id"))
        val publishedStep = published.getJSONObject("steps").getJSONArray("items").getJSONObject(0)
        assertEquals("Step 73 failed", publishedStep.getJSONObject("detail").getString("text"))

        val stale = page.copy(stale = true)
        assertTrue(stale.accepts(null))
        assertTrue(stale.accepts("next"))
        val updated = encode(projection, base.copy(stepPages = mapOf("first" to stale.wire(details))))
        val staleSteps = updated.getJSONArray("entries").getJSONObject(0).getJSONObject("steps")
        assertTrue(staleSteps.getBoolean("stale"))
        assertEquals(publishedStep.toString(), staleSteps.getJSONArray("items").getJSONObject(0).toString())

        val reset = encode(projection, base.copy(topic = "other", turn = ReaderTurnContext()))
        assertFalse(reset.getBoolean("turnWindow"))
        assertEquals(listOf("input", "progress", "answer"), order(reset))
        assertFalse(reset.toString().contains("\"steps\""))
    }
    @Test fun mixedCommentaryRemainsPartOfTheSameReaderMessageAfterRefresh() {
        val projection = ReaderProjection()
        val commentary = JSONObject().put("text", "note").put("range", JSONObject().put("revision", "c:8").put("start", 6).put("end", 10).put("total", 10))
        val original = message("answer", "final").put("commentary", commentary)
        val legacy = snapshot("task:branch", listOf(original))
        fun row(update: JSONObject): JSONObject = update.getJSONArray("entries").getJSONObject(0).getJSONArray("messages").getJSONObject(0)
        assertFalse(row(encode(projection, legacy)).has("commentary"))
        val current = legacy.copy(turn = ReaderTurnContext(enabled = true))
        val final = row(encode(projection, current))
        assertEquals("answer", final.getString("id"))
        assertEquals("final", final.getString("text"))
        assertEquals(commentary.toString(), final.getJSONObject("commentary").toString())
        projection.reset()
        val refreshed = encode(projection, current)
        assertEquals(listOf("answer"), order(refreshed))
        assertEquals(commentary.toString(), row(refreshed).getJSONObject("commentary").toString())
    }
    @Test fun anchorRequestRemainsScopedToItsTopicAndDoesNotNeedMessageChanges() {
        val projection = ReaderProjection()
        val first = snapshot("one", listOf(message("target", "old message")))
        encode(projection, first)
        val anchored = first.copy(anchorMessageId = "target", anchorRequestId = "search-1", hasLaterMessages = true)
        val update = encode(projection, anchored)
        assertEquals("target", update.getString("anchorMessageId"))
        assertEquals("search-1", update.getString("anchorRequestId"))
        assertTrue(update.getBoolean("hasLaterMessages"))
        assertEquals(0, update.getJSONArray("entries").length())
        val other = encode(projection, anchored.copy(topic = "two"))
        assertTrue(other.isNull("anchorMessageId")); assertTrue(other.isNull("anchorRequestId"))
        val next = encode(projection, anchored.copy(topic = "two", anchorRequestId = "search-2"))
        assertEquals("target", next.getString("anchorMessageId"))
        val missing = encode(projection, anchored.copy(topic = "two", anchorMessageId = "absent", anchorRequestId = "search-3"))
        assertEquals("absent", missing.getString("anchorMessageId"))
        val latest = encode(projection, first.copy(topic = "two"))
        assertTrue(latest.isNull("anchorMessageId")); assertFalse(latest.getBoolean("hasLaterMessages"))
    }
    @Test fun userPhotoIsBoundToItsMessageAndRevisionWithoutRequiringANewBindingId() {
        val photo = JSONObject().put("resourceId", "attachment:photo").put("revision", "v1").put("name", "camera.jpg")
            .put("kind", "attachment").put("mimeType", "image/jpeg").put("availability", "ready").put("sizeBytes", "512")
        fun variant(key: String, value: String) = JSONObject(photo.toString()).put(key, value)
        val ordinary = variant("mimeType", "application/pdf").put("resourceId", "attachment:doc")
        val missingRevision = JSONObject(photo.toString()).apply { remove("revision") }.put("resourceId", "attachment:legacy")
        val user = message("msg", "caption").put("role", "user").put("resources", JSONArray(listOf(photo, ordinary, missingRevision)))
        val action = JSONObject().put("id", "msg").put("resourceId", "attachment:photo").put("revision", "v1")
        assertEquals(photo.toString(), ReaderMessagePhotos.resolve(user, action)?.toString())
        assertNull(ReaderMessagePhotos.resolve(JSONObject(user.toString()).put("role", "assistant"), action))
        assertNull(ReaderMessagePhotos.resolve(JSONObject(user.toString()).put("id", "other"), action))
        assertNull(ReaderMessagePhotos.resolve(user, JSONObject(action.toString()).put("revision", "v2")))
        assertFalse(ReaderMessagePhotos.isPhoto("user", variant("name", "active.svg")))
        assertFalse(ReaderMessagePhotos.isPhoto("user", variant("kind", "reference")))
        assertFalse(ReaderMessagePhotos.canLoad(variant("availability", "unavailable")))
        assertFalse(ReaderMessagePhotos.canLoad(variant("sizeBytes", (20L * 1024 * 1024 + 1).toString())))
        val projection = ReaderProjection()
        val base = snapshot("task:one", listOf(user, message("other", "unchanged")))
        val initial = encode(projection, base).getJSONArray("entries").getJSONObject(0).getJSONArray("messages").getJSONObject(0).getJSONArray("resources")
        assertEquals("unavailable", initial.getJSONObject(0).getJSONObject("photo").getString("status"))
        assertFalse(initial.getJSONObject(1).has("photo")); assertFalse(initial.getJSONObject(2).has("photo"))
        val changed = encode(projection, base.copy(photoEpoch = Any())) {
            ReaderPhotoState("ready", "${ReaderView.ORIGIN}/artifacts/${"a".repeat(64)}.png")
        }
        val entries = changed.getJSONArray("entries")
        assertEquals(1, entries.length())
        assertEquals("ready", entries.getJSONObject(0).getJSONArray("messages").getJSONObject(0).getJSONArray("resources").getJSONObject(0).getJSONObject("photo").getString("status"))
        val next = encode(projection, base.copy(topic = "task:two"))
        assertFalse(next.toString().contains("/artifacts/"))
    }
    @Test fun transcriptAppendRequiresUnchangedPrefixAndTopic() {
        val projection = ReaderProjection()
        fun event(sequence: Int) = JSONObject().put("runId", "run").put("sequence", sequence).put("type", "run.started").put("createdAt", "2026-11-11T05:00:00Z").put("payload", JSONObject())
        fun transcript(vararg events: JSONObject) = mapOf("run" to JSONObject().put("events", JSONArray(events.toList())).put("loaded", true))
        fun encodedTranscript(topic: String, vararg events: JSONObject) =
            encode(projection, snapshot(topic, emptyList(), transcript(*events))).getJSONObject("transcripts").getJSONObject("run")
        fun sequences(update: JSONObject): List<Int> = update.getJSONArray("events").let { array ->
            (0 until array.length()).map { array.getJSONObject(it).getInt("sequence") }
        }
        val first = event(1)
        val second = event(2)
        encodedTranscript("one", first)
        val appended = encodedTranscript("one", first, second)
        assertTrue(appended.getBoolean("append"))
        assertEquals(listOf(2), sequences(appended))

        val replacement = event(3)
        val replaced = encodedTranscript("one", first, replacement)
        assertFalse(replaced.getBoolean("append"))
        assertEquals(listOf(1, 3), sequences(replaced))
        val switched = encodedTranscript("two", first, replacement, event(4))
        assertFalse(switched.getBoolean("append"))
        assertEquals(listOf(1, 3, 4), sequences(switched))
    }
}
