package app.uselexora.mobile

import app.uselexora.mobile.i18n.MobileStrings
import app.uselexora.mobile.i18n.mobileQuantity
import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.protocol.ApprovalReview
import app.uselexora.mobile.protocol.ExecutionSettings
import app.uselexora.mobile.protocol.MobileContentAdapter
import app.uselexora.mobile.ui.ReaderProjection
import app.uselexora.mobile.ui.ReaderSnapshot
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Test

class MobileLocalizationTest {
    init { TestMobileStrings.install() }
    @After fun resetLanguage() { MobileStrings.language = "zh" }
    @Test fun countsAndModeLabelsFollowLanguageWithoutChangingExecutionConfig() {
        val mode = ExecutionSettings.modes[0]
        val config = mode.config().toString()
        assertEquals("本机只读", mode.label)
        MobileStrings.language = "en"
        assertEquals("Read only", mode.label)
        assertEquals(config, mode.config().toString())
        assertEquals("1 task", mobileQuantity(R.plurals.mobile_tasks, 1))
        assertEquals("2 tasks", mobileQuantity(R.plurals.mobile_tasks, 2))
        assertEquals("0 tasks", mobileQuantity(R.plurals.mobile_tasks, 0))
        MobileStrings.language = "zh"
        assertEquals("2 个任务", mobileQuantity(R.plurals.mobile_tasks, 2))
    }
    @Test fun approvalParametersAndMessageContentAreNotTranslated() {
        MobileStrings.language = "en"
        val value = "关闭：全部空间，正在连接…"
        val review = JSONObject().put("status", "pending").put("review", JSONObject().put("document", JSONObject().put("text",
            JSONObject().put("kind", "shell").put("toolName", value).put("arguments", JSONObject().put("command", value)).toString())))
        val sections = ApprovalReview.sections(review)
        assertTrue(sections.any { it.second == value })
        assertTrue(sections.any { it.second.contains(JSONObject.quote(value)) })
        val content = MobileContentAdapter.textContent(value)
        assertEquals(value, MobileContentAdapter.text(content))
    }
    @Test fun unchangedMessagesRefreshLocalizedMetadataWhenLanguageChanges() {
        val message = JSONObject().put("id", "message").put("role", "assistant").put("body", JSONObject().put("kind", "text").put("text", "保留用户原文"))
        val projection = ReaderProjection()
        fun encode() = projection.encode(ReaderSnapshot(listOf(message), "topic", emptyMap(), emptyList(), emptyMap(), false, 1f, MobileStrings.language, null, emptyMap()), { JSONObject() }, { JSONObject() })
        val original = encode().getJSONArray("entries").getJSONObject(0).getJSONArray("messages").getJSONObject(0)
        assertEquals(mobileText(R.string.mobile_assistant), original.getString("author"))
        assertEquals(0, encode().getJSONArray("entries").length())
        MobileStrings.language = "en"
        val translated = encode().getJSONArray("entries").getJSONObject(0).getJSONArray("messages").getJSONObject(0)
        assertEquals("Assistant", translated.getString("author"))
        assertEquals("保留用户原文", translated.getString("text"))
    }
}
