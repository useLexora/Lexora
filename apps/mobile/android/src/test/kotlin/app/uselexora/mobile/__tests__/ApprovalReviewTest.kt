package app.uselexora.mobile

import app.uselexora.mobile.protocol.ApprovalReview
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class ApprovalReviewTest {
    init { app.uselexora.mobile.TestMobileStrings.install() }
    private val now = Instant.parse("2026-11-07T00:00:00Z")
    private fun approval(): JSONObject = JSONObject().put("kind", "shell").put("status", "pending").put("review", JSONObject()
        .put("contentVersion", 1).put("complete", true).put("persistentEffect", false).put("localManagementRequired", false)
        .put("expiresAt", "2026-11-07T01:00:00Z").put("allowedDecisions", JSONArray(listOf("approved", "denied", "approved_persistently")))
        .put("document", JSONObject().put("format", "json").put("text", JSONObject().put("kind", "shell").put("toolName", "shell").put("arguments", JSONObject().put("command", "printf fixture")).toString())))
    @Test fun completeKnownReviewOffersOnlyExplicitNonPersistentDecisions() {
        assertEquals(listOf("approved", "denied"), ApprovalReview.decisions(approval(), now))
    }
    @Test fun expiredResolvedAndUnavailableReviewsNeverOfferApproval() {
        val expired = approval(); expired.getJSONObject("review").put("expiresAt", "2026-11-06T23:59:59Z")
        assertTrue(ApprovalReview.decisions(expired, now).isEmpty())
        assertTrue(ApprovalReview.decisions(approval().put("status", "approved"), now).isEmpty())
        val missing = approval(); missing.getJSONObject("review").put("document", JSONObject.NULL)
        assertEquals(listOf("denied"), ApprovalReview.decisions(missing, now))
    }
    @Test fun downloadedBodyCannotOverrideAChangedReviewOrCurrentPermission() {
        val shown = approval().put("id", "approval").put("runId", "run")
        shown.getJSONObject("review").put("reviewVersion", "version").put("resourceId", "resource")
        val latest = JSONObject(shown.toString())
        latest.getJSONObject("review").put("document", JSONObject.NULL).put("complete", false)
        val attached = app.uselexora.mobile.network.ApprovalDocuments.attach(latest, shown)
        assertEquals(listOf("denied"), ApprovalReview.decisions(attached, now))
        assertTrue(latest.getJSONObject("review").isNull("document"))
        latest.getJSONObject("review").put("complete", true)
        assertTrue(ApprovalReview.decisions(app.uselexora.mobile.network.ApprovalDocuments.attach(latest, shown), now).contains("approved"))
        for (field in listOf("reviewVersion", "resourceId")) {
            val changed = JSONObject(latest.toString()); changed.getJSONObject("review").put(field, "changed")
            assertTrue(runCatching { app.uselexora.mobile.network.ApprovalDocuments.attach(changed, shown) }.isFailure)
        }
        assertTrue(runCatching { app.uselexora.mobile.network.ApprovalDocuments.attach(JSONObject(latest.toString()).put("runId", "replacement"), shown) }.isFailure)
    }
    @Test fun unfamiliarFieldsRemainVisibleButCannotBeApproved() {
        val item = approval()
        item.getJSONObject("review").getJSONObject("document").put("text", JSONObject().put("kind", "shell").put("toolName", "shell").put("arguments", JSONObject().put("command", "printf fixture")).put("futureGrant", "global").toString())
        assertEquals(listOf("denied"), ApprovalReview.decisions(item, now))
        assertTrue(ApprovalReview.sections(item).contains("未识别字段：futureGrant" to "global"))
        assertTrue(ApprovalReview.sections(item).any { it.first == "操作参数" && it.second.contains("printf fixture") })
    }
    @Test fun serviceClockUsesElapsedTimeIncludingSuspendAndRejectsAnInvalidAnchor() {
        val clock = app.uselexora.mobile.protocol.ServiceTime(now, 10L)
        assertEquals(now.plusSeconds(3), clock.now(3_000_000_010L))
        assertTrue(ApprovalReview.decisions(approval(), clock.now(3_600_000_000_010L)).isEmpty())
        assertTrue(runCatching { clock.now(0) }.isFailure)
    }
    @Test fun originalDecisionIdentifiesItsDeviceAndCannotAttachToAnotherReview() {
        val shown = approval().put("id", "approval").put("runId", "run").put("status", "denied").put("resolution", "denied").put("resolvedAt", now.toString())
        shown.getJSONObject("review").put("reviewVersion", "version")
        val decision = JSONObject().put("approvalId", "approval").put("runId", "run").put("reviewVersion", "version").put("status", "denied").put("resolution", "denied").put("resolvedAt", now.toString())
            .put("actor", JSONObject().put("id", "device").put("kind", "device").put("current", true)).put("cancellationReason", JSONObject.NULL)
        assertTrue(ApprovalReview.decisionSections(shown, decision).contains("处理方" to "此手机"))
        assertTrue(ApprovalReview.decisions(shown, now).isEmpty())
        for (field in listOf("approvalId", "runId", "reviewVersion", "status", "resolution", "resolvedAt")) {
            assertTrue(ApprovalReview.decisionSections(shown, JSONObject(decision.toString()).put(field, "changed")).isEmpty())
        }
        decision.getJSONObject("actor").put("current", false)
        assertTrue(ApprovalReview.decisionSections(shown, decision).contains("处理方" to "其他设备"))
        decision.getJSONObject("actor").put("kind", "desktop")
        assertTrue(ApprovalReview.decisionSections(shown, decision).contains("处理方" to "桌面端"))
        decision.put("actor", JSONObject.NULL).put("cancellationReason", "expired").put("status", "cancelled").put("resolution", "cancelled")
        shown.put("status", "cancelled").put("resolution", "cancelled")
        assertTrue(ApprovalReview.decisionSections(shown, decision).contains("取消原因" to "审批已到期"))
        assertTrue(ApprovalReview.decisionSections(shown, null).isEmpty())
    }
    @Test fun unknownMismatchedOrPersistentOperationRemainsReadOnly() {
        val unknown = approval().put("kind", "future_operation")
        assertEquals(listOf("denied"), ApprovalReview.decisions(unknown, now))
        for (field in listOf("persistentEffect", "localManagementRequired")) {
            val value = approval(); value.getJSONObject("review").put(field, true)
            assertEquals(listOf("denied"), ApprovalReview.decisions(value, now))
        }
        val incomplete = approval(); incomplete.getJSONObject("review").put("complete", false)
        assertEquals(listOf("denied"), ApprovalReview.decisions(incomplete, now))
    }
}
