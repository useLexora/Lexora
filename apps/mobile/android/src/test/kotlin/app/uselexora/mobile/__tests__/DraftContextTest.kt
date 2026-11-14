package app.uselexora.mobile

import app.uselexora.mobile.protocol.DraftContext
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class DraftContextTest {
    init { app.uselexora.mobile.TestMobileStrings.install() }
    @Test fun recoveredScopesKeepExactIdentityIncludingSpaceNamesOutsideTaskIdSyntax() {
        for (scope in listOf("global", "draft:task", "conversation:task:branch", "message-edit:task:branch:input", "message-followup:task:branch:reply", "space:中文 空间:工作目录"))
            assertEquals(scope, DraftContext.key(DraftContext.target(scope)))
        assertTrue(runCatching { DraftContext.target("space: ") }.isFailure)
    }
    @Test fun explicitRemovalOverridesRecoveredScopeAndNeverRetargetsExistingConversations() {
        val saved = JSONObject().put("scope", JSONObject().put("kind", "task").put("spaceId", "original"))
        val target = JSONObject().put("kind", "task").put("draftId", "draft").put("spaceId", "stale")
        assertEquals("original", DraftContext.scope(saved, target).getString("spaceId"))
        saved.put("spaceId", JSONObject.NULL)
        assertTrue(DraftContext.scope(saved, target).isNull("spaceId"))
        assertEquals("stale", target.getString("spaceId"))
        val conversation = JSONObject().put("kind", "conversation_branch").put("conversationId", "conversation").put("branchId", "branch")
        assertFalse(DraftContext.scope(saved.put("spaceId", "new"), conversation).has("spaceId"))
    }
}
