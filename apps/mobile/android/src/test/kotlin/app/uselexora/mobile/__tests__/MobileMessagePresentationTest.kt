package app.uselexora.mobile

import app.uselexora.mobile.protocol.MobileContentAdapter
import app.uselexora.mobile.protocol.MobileMessagePresentation
import app.uselexora.mobile.protocol.MobileMessageDetail
import app.uselexora.mobile.protocol.ProtocolSchemas
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.io.RandomAccessFile

class MobileMessagePresentationTest {
    init { app.uselexora.mobile.TestMobileStrings.install() }
    @Test fun transcriptKeepsOneIdentityPerSpeakerAndExposesEveryToolCall() {
        fun reply(id: String, run: String = "run", actor: String = "default") = message(id, "assistant", JSONObject().put("kind", "text").put("text", id))
            .put("runId", run).put("author", JSONObject().put("id", actor))
        val rows = MobileMessagePresentation.transcript(listOf(reply("before"), tool("a"), tool("b"), reply("result"),
            reply("other", actor = "reviewer"), reply("next", run = "next"), message("user", "user", JSONObject().put("kind", "text").put("text", "补充")), reply("after-user", run = "next")))
        assertEquals(listOf("before", "a", "b", "result", "other", "next", "user", "after-user"), rows.map { it.message.id })
        assertEquals(listOf("before", "other", "next", "after-user"), rows.filter { it.showIdentity }.map { it.message.id })
        assertTrue(rows.first().intermediate)
        assertFalse(rows[3].showIdentity)
        assertTrue(rows[3].continuation)
        assertFalse(rows.last().continuation)
    }

    @Test fun keepsIncompleteAndAttachmentOnlyRepliesAndHidesOnlyEmptyReplies() {
        val empty = message("empty", "assistant", JSONObject().put("kind", "text").put("text", ""))
        val interrupted = message("interrupted", "assistant", JSONObject().put("kind", "text").put("text", "").put("interrupted", true))
        val large = message("large", "assistant", JSONObject().put("kind", "resource").put("resourceId", "message:large").put("previewText", ""))
        val attachment = message("attachment", "assistant", JSONObject().put("kind", "text").put("text", "")).put("resources", JSONArray().put(JSONObject().put("name", "结果.pdf")))
        assertEquals(listOf("interrupted", "large", "attachment"), MobileMessagePresentation.entries(listOf(empty, interrupted, large, attachment)).map { it.id })
        assertTrue(MobileMessagePresentation.message(large).needsDetail)
    }

    @Test fun detailDocumentsRenderSupportedContentAndKeepTheWholeQuote() {
        val schemas = ProtocolSchemas(JSONObject(File("build/generated/protocol/protocol-schema.json").readText()))
        val content = MobileContentAdapter.textContent("正文😀")
        val quote = "引用正文".repeat(100)
        content.put("quotes", JSONArray().put(JSONObject().put("id", "quote").put("text", quote).put("source", JSONObject()
            .put("conversationId", "conversation").put("branchId", "branch").put("messageId", "message").put("role", "assistant").put("runId", JSONObject.NULL))))
        content.getJSONArray("body").getJSONObject(0).getJSONArray("content")
            .put(JSONObject().put("type", "quote_ref").put("quoteKind", "message").put("quoteId", "quote"))
        val resource = JSONObject().put("resourceId", "message:user").put("mimeType", "application/json")
        val file = File.createTempFile("message-detail", ".json")
        try {
            file.writeText(content.toString())
            val result = MobileMessagePresentation.readDetail(file, resource, schemas, emptyList())
            assertTrue(result.text!!.startsWith("正文😀"))
            assertTrue(result.text.contains(quote))
            assertFalse(result.text.contains("\"version\""))
            content.put("privateExtra", "not a supported document")
            file.writeText(content.toString())
            val unsupported = MobileMessagePresentation.readDetail(file, resource, schemas, emptyList())
            assertNull(unsupported.text)
            assertNotNull(unsupported.notice)
            assertEquals("message:user", unsupported.resource!!.getString("resourceId"))
        } finally { file.delete() }
    }

    @Test fun largeDocumentsKeepTheResourceInsteadOfBecomingInlineText() {
        val schemas = ProtocolSchemas(JSONObject(File("build/generated/protocol/protocol-schema.json").readText()))
        val resource = JSONObject().put("resourceId", "message:large").put("mimeType", "text/plain; charset=utf-8")
        val file = File.createTempFile("message-large", ".txt")
        try {
            file.writeText("开头😀")
            RandomAccessFile(file, "rw").use { it.setLength(MobileMessagePresentation.MAX_INLINE_DETAIL_BYTES.toLong() + 1) }
            val result = MobileMessagePresentation.readDetail(file, resource, schemas, emptyList())
            assertNull(result.text)
            assertNull(result.error)
            assertNotNull(result.notice)
            assertEquals("message:large", result.resource!!.getString("resourceId"))
        } finally { file.delete() }
    }

    @Test fun messageDetailsSurviveEquivalentSnapshotsButNeverCoverNewerOutput() {
        val source = message("stream", "assistant", JSONObject().put("kind", "text").put("text", "原始预览").put("truncated", true))
        val detail = MobileMessageDetail(text = "已读取的完整保存内容", sourceBody = source.getJSONObject("body").toString())
        assertNotNull(MobileMessagePresentation.matchingDetail(JSONObject(source.toString()), detail))
        source.getJSONObject("body").put("text", "后续新的输出")
        assertNull(MobileMessagePresentation.matchingDetail(source, detail))
    }

    private fun tool(id: String, name: String = "read", error: Boolean = false, run: String = "run") = message(id, "tool", JSONObject().put("kind", "resource").put("resourceId", "message:$id").put("previewText", "")).put("runId", run).put("tool", JSONObject().put("name", name).put("isError", error))
    private fun message(id: String, role: String, body: JSONObject) = JSONObject().put("id", id).put("role", role).put("runId", "run").put("body", body).put("resources", JSONArray())
}
