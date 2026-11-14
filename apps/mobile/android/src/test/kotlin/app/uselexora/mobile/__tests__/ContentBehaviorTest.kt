package app.uselexora.mobile

import app.uselexora.mobile.protocol.MobileContentAdapter
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class ContentBehaviorTest {
    init { app.uselexora.mobile.TestMobileStrings.install() }
    private val vectors = JSONObject(File("build/generated/protocol/content-behavior-vectors.json").readText())
    @Test fun crossClientTextKeepsUtf16AndTheExistingMobileEncoding() {
        val entries = vectors.getJSONArray("textCases")
        for (index in 0 until entries.length()) {
            val entry = entries.getJSONObject(index)
            val text = entry.getString("text")
            val content = MobileContentAdapter.textContent(text)
            assertEquals(entry.getString("name"), text, MobileContentAdapter.text(content))
            assertEquals(entry.getInt("utf16Length"), text.length)
            assertEquals(entry.getInt("androidParagraphs"), content.getJSONArray("body").length())
            assertTrue(MobileContentAdapter.canEditAsText(content))
        }
    }
    @Test fun sharedContentVectorsKeepSourceMetadataAndDeclareReadonlyBoundaries() {
        val entries = vectors.getJSONArray("contents")
        for (index in 0 until entries.length()) {
            val entry = entries.getJSONObject(index)
            val content = entry.getJSONObject("value")
            val before = content.toString()
            val resources = entry.optJSONArray("resources")?.let { values -> (0 until values.length()).map { values.getJSONObject(it) } } ?: emptyList()
            assertEquals(entry.getString("name"), entry.getBoolean("editable"), MobileContentAdapter.canEditAsText(content))
            assertEquals(entry.getString("preview"), MobileContentAdapter.text(content))
            assertEquals(entry.getString("message"), MobileContentAdapter.text(content, MobileContentAdapter.Presentation.Message, resources))
            assertEquals(before, content.toString())
            val wrapped = JSONObject().put("kind", "editable").put("content", content)
            assertEquals(entry.getBoolean("editable"), MobileContentAdapter.canEditAsText(wrapped))
        }
    }
}
