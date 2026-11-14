package app.uselexora.mobile.ui

import org.junit.Assert.*
import org.junit.Test

class MobileReadingPolicyTest {
    init { app.uselexora.mobile.TestMobileStrings.install() }
    @Test fun onlyExplicitWebLinksCanLeaveTheApp() {
        assertEquals("https://example.com/a?q=%E4%B8%AD%E6%96%87#part", MobileReadingPolicy.webLink("https://example.com/a?q=中文#part"))
        assertEquals("http://127.0.0.1:8080/result", MobileReadingPolicy.webLink("http://127.0.0.1:8080/result"))
        listOf("javascript:alert(1)", "data:text/html,hello", "file:///tmp/result", "content://files/1", "intent://open", "mailto:a@example.com", "//example.com", "https:///missing-host", "https://user:secret@example.com", "https://example.com:70000", "https://example.com/\nfile").forEach {
            assertNull(it, MobileReadingPolicy.webLink(it))
        }
    }

}
