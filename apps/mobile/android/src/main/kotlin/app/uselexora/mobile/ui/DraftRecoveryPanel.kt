package app.uselexora.mobile.ui

import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.i18n.mobileQuantity
import app.uselexora.mobile.protocol.DraftContext
import android.widget.LinearLayout
import android.widget.TextView
import app.uselexora.mobile.R
import app.uselexora.mobile.protocol.MobileContentAdapter
import android.app.Activity
import android.app.AlertDialog
import app.uselexora.mobile.protocol.ProtocolFailure
import app.uselexora.mobile.storage.LocalDraft
import app.uselexora.mobile.storage.LocalStore
import org.json.JSONObject

class DraftRecoveryPanel(
    private val activity: Activity,
    private val store: LocalStore,
    private val owner: () -> String,
    private val work: (() -> Unit) -> Unit,
    private val ui: (() -> Unit) -> Unit,
    private val restore: (LocalDraft, String) -> Unit,
    private val targetLabel: (LocalDraft) -> String? = { null },
    private val attachmentLookup: () -> (LocalDraft) -> String? = { { null } }
) {
    private fun candidates(partition: String, reachable: Set<String>, limit: Int, attachmentSummary: (LocalDraft) -> String?) =
        store.drafts(includeScope = { identity, scope -> identity != partition || scope !in reachable }, limit = limit) { draft ->
            val content = draft.value.getJSONObject("content")
            MobileContentAdapter.text(content).isNotBlank() || (content.optJSONArray("panelResourceIds")?.length() ?: 0) > 0 ||
                !MobileContentAdapter.canEditAsText(content) || !attachmentSummary(draft).isNullOrBlank()
        }

    fun hasUnplaced(partition: String, reachable: Set<String>) = candidates(partition, reachable, 1, attachmentLookup()).isNotEmpty()

    fun local(reachable: Set<String> = emptySet(), partition: String = owner()) = work {
        val attachmentSummary = attachmentLookup()
        val drafts = candidates(partition, reachable, Int.MAX_VALUE, attachmentSummary)
        val attachments = drafts.associate { (it.partition to it.scope) to attachmentSummary(it) }
        val pending = drafts.filter(store::hasPendingDraftCommand).map { it.partition to it.scope }.toSet()
        ui {
            if (owner() != partition) return@ui
            val header = LinearLayout(activity).apply {
                orientation = LinearLayout.VERTICAL
                val padding = (24 * resources.displayMetrics.density).toInt()
                setPadding(padding, padding, padding, padding / 2)
                addView(TextView(activity).apply { text = mobileText(R.string.mobile_phone_drafts); textSize = 20f })
                addView(TextView(activity).apply { text = mobileText(R.string.phone_drafts_hint); textSize = 14f; setPadding(0, padding / 3, 0, 0) })
            }
            val dialog = AlertDialog.Builder(activity).setCustomTitle(header).setNegativeButton(mobileText(R.string.review_close), null)
            if (drafts.isEmpty()) dialog.setMessage(mobileText(R.string.phone_drafts_empty))
            else dialog.setItems(drafts.map {
                "${if (it.partition == partition) mobileText(R.string.mobile_current_connection) else mobileText(R.string.mobile_previous_connection)} · ${target(it)}\n${preview(it.value, 80, attachments[it.partition to it.scope])}${if ((it.partition to it.scope) in pending) "\n${mobileText(R.string.mobile_result_unconfirmed)}" else ""}"
            }.toTypedArray()) { _, index ->
                val draft = drafts[index]
                if (owner() == partition) localActions(draft, partition, (draft.partition to draft.scope) in pending, attachments[draft.partition to draft.scope])
            }
            dialog.show()
        }
    }
    private fun localActions(draft: LocalDraft, partition: String, pending: Boolean, attachments: String?) {
        val content = draft.value.getJSONObject("content")
        val sameOwner = draft.partition == partition
        val dialog = AlertDialog.Builder(activity).setTitle(if (sameOwner) mobileText(R.string.mobile_phone_drafts) else mobileText(R.string.mobile_previous_draft))
            .setMessage("${target(draft)}\n${mobileText(R.string.mobile_saved_on_phone)}\n\n${preview(draft.value, extra = attachments)}${if (pending) "\n\n${mobileText(R.string.mobile_the_result_is_still_unknown_check_again_later_no)}" else ""}${if (sameOwner) "" else mobileText(R.string.mobile_this_draft_belongs_to_a_previous_service_connection_you)}")
            .setNegativeButton(mobileText(R.string.review_close), null)
        if (sameOwner) dialog.setPositiveButton(if (MobileContentAdapter.canEditAsText(content)) mobileText(R.string.mobile_continue_editing) else mobileText(R.string.mobile_view_content)) { _, _ -> work {
            val latest = store.draft(draft.partition, draft.scope) ?: throw ProtocolFailure("OBJECT_DELETED")
            ui { if (owner() == partition) restore(latest, "") }
        } }
        if (!pending && MobileContentAdapter.canEditAsText(content) && MobileContentAdapter.text(content).isNotBlank()) dialog.setNeutralButton(mobileText(R.string.mobile_copy_text)) { _, _ -> work {
            val copy = store.edit(partition, "draft:${store.newId()}", JSONObject().put("content", MobileContentAdapter.textContent(MobileContentAdapter.text(content))))
            ui { if (owner() == partition) restore(copy, mobileText(R.string.mobile_new_draft_created)) }
        } }
        dialog.show()
    }
    private fun target(draft: LocalDraft): String = targetLabel(draft)?.takeIf { it.isNotBlank() } ?: when (runCatching { DraftContext.target(draft.scope).optString("kind") }.getOrNull()) {
        "message_edit" -> mobileText(R.string.mobile_edit_previous_input)
        "message_followup" -> mobileText(R.string.label_continue_from_here)
        "conversation_branch" -> mobileText(R.string.mobile_continue_editing)
        "task", "global", "space" -> mobileText(R.string.incoming_new_draft)
        else -> mobileText(R.string.mobile_draft)
    }
    private fun preview(value: JSONObject, limit: Int = 500, extra: String? = null): String {
        val content = value.getJSONObject("content")
        val text = MobileContentAdapter.summary(MobileContentAdapter.text(content), limit)
        val attachments = content.optJSONArray("panelResourceIds")?.length() ?: 0
        return listOfNotNull(text.takeIf { it.isNotBlank() }, attachments.takeIf { it > 0 }?.let { mobileQuantity(R.plurals.draft_attachment_count, it) }, extra?.takeIf { it.isNotBlank() }).joinToString("\n")
            .ifBlank { mobileText(R.string.mobile_view_content) }
    }
}
