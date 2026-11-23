package app.uselexora.mobile

import app.uselexora.mobile.protocol.MobileContentAdapter
import app.uselexora.mobile.protocol.ProductProtocol
import app.uselexora.mobile.protocol.ProtocolSchemas
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class ProductProtocolTest {
    private val schemas = ProtocolSchemas(JSONObject(File("build/generated/protocol/protocol-schema.json").readText()))
    private val vectors = JSONObject(File("build/generated/protocol/vectors.json").readText())
    @Test fun initializationRequiresProtocol11WithoutLegacyProjection() {
        val request = ProductProtocol.initialize("test")
        assertTrue(schemas.request("initialize", request))
        val protocol = request.getJSONObject("protocol")
        assertEquals(1, protocol.getInt("major"))
        assertEquals(1, protocol.getInt("minMinor"))
        assertEquals(1, protocol.getInt("maxMinor"))
        val outputProtocol = schemas.document.getJSONObject("initialize").getJSONObject("output").getJSONObject("properties").getJSONObject("protocol")
        assertTrue(schemas.valid(JSONObject().put("major", 1).put("minor", 1), outputProtocol))
        assertFalse(schemas.valid(JSONObject().put("major", 1).put("minor", 0), outputProtocol))
    }
    @Test fun supportedObjectAndExclusiveBoundsAreEnforced() {
        val bounded = JSONObject("""{"type":"number","exclusiveMinimum":0,"exclusiveMaximum":2}""")
        assertFalse(schemas.valid(0, bounded)); assertFalse(schemas.valid(2, bounded)); assertTrue(schemas.valid(1, bounded))
        val objectSchema = JSONObject("""{"type":"object","propertyNames":{"type":"string","pattern":"^id-"},"additionalProperties":{"type":"integer","minimum":1}}""")
        assertTrue(schemas.valid(JSONObject().put("id-a", 1), objectSchema))
        assertFalse(schemas.valid(JSONObject().put("other", 1), objectSchema))
        assertFalse(schemas.valid(JSONObject().put("id-a", 0), objectSchema))
    }
    @Test fun allSharedRequestVectors() {
        val entries = vectors.getJSONArray("requests")
        for (index in 0 until entries.length()) {
            val item = entries.getJSONObject(index)
            assertEquals(item.getString("name"), item.getBoolean("valid"), schemas.request(item.getString("method"), item.getJSONObject("params")))
        }
    }
    @Test fun allSharedResponseVectors() {
        val entries = vectors.getJSONArray("responses")
        for (index in 0 until entries.length()) {
            val item = entries.getJSONObject(index)
            assertEquals(item.getString("name"), item.getBoolean("valid"), schemas.response(item.getString("method"), item.get("result")))
        }
    }
    @Test fun allSharedContentVectors() {
        val entries = vectors.getJSONArray("contents")
        for (index in 0 until entries.length()) {
            val item = entries.getJSONObject(index)
            assertEquals(item.getString("name"), item.getBoolean("valid"), schemas.content(item.getJSONObject("value")))
        }
    }
    @Test fun allSharedIntegerVectors() {
        val entries = vectors.getJSONArray("revisions")
        for (index in 0 until entries.length()) {
            val item = entries.getJSONObject(index)
            assertEquals(item.getString("name"), item.getBoolean("valid"), runCatching { ProductProtocol.revision(item.get("value")) }.isSuccess)
        }
    }
    @Test fun plainTextEditingNeverStripsMarksOrParagraphMetadata() {
        val marked = MobileContentAdapter.textContent("保留样式")
        marked.getJSONArray("body").getJSONObject(0).getJSONArray("content").getJSONObject(0).put("marks", org.json.JSONArray().put(JSONObject().put("type", "bold")))
        assertFalse(MobileContentAdapter.canEditAsText(marked))
        assertTrue(marked.toString().contains("bold"))
        val aligned = MobileContentAdapter.textContent("保留段落")
        aligned.getJSONArray("body").getJSONObject(0).put("alignment", "center")
        assertFalse(MobileContentAdapter.canEditAsText(aligned))
    }
    @Test fun continuousFramesNeverAdvanceOnGapOrOldEpoch() {
        fun delta(epoch: String, from: String, to: String) = JSONObject().put("syncEpoch", epoch).put("fromSeq", from).put("toSeq", to)
        assertEquals("apply", ProductProtocol.classifyDelta("a", "9007199254740992", delta("a", "9007199254740992", "9007199254740993")))
        assertEquals("duplicate", ProductProtocol.classifyDelta("a", "12", delta("a", "9", "12")))
        assertEquals("resync", ProductProtocol.classifyDelta("a", "12", delta("a", "13", "14")))
        assertEquals("resync", ProductProtocol.classifyDelta("a", "12", delta("old", "12", "13")))
    }
}
