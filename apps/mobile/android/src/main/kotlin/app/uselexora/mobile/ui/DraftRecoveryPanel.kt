package app.uselexora.mobile.ui

import app.uselexora.mobile.i18n.mobileText
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
    private val restore: (LocalDraft, String) -> Unit
) {
    fun local() = work {
        val partition = owner()
        val drafts = store.drafts().filter { draft ->
            val content = draft.value.getJSONObject("content")
            MobileContentAdapter.text(content).isNotBlank() || (content.optJSONArray("panelResourceIds")?.length() ?: 0) > 0 || !MobileContentAdapter.canEditAsText(content)
        }
        ui {
            if (owner() != partition) return@ui
            AlertDialog.Builder(activity).setTitle(mobileText(R.string.mobile_phone_drafts)).setItems(drafts.map {
                "${if (it.partition == partition) mobileText(R.string.mobile_draft) else mobileText(R.string.mobile_previous_connection)} · ${summary(it.value)}"
            }.toTypedArray()) { _, index -> localActions(drafts[index], partition) }.setNegativeButton(mobileText(R.string.review_close), null).show()
        }
    }
    private fun localActions(draft: LocalDraft, partition: String) {
        val content = draft.value.getJSONObject("content")
        val sameOwner = draft.partition == partition
        val dialog = AlertDialog.Builder(activity).setTitle(if (sameOwner) mobileText(R.string.mobile_phone_drafts) else mobileText(R.string.mobile_previous_draft))
            .setMessage("${preview(draft.value)}${if (sameOwner) "" else mobileText(R.string.mobile_this_draft_belongs_to_a_previous_service_connection_you)}")
            .setNegativeButton(mobileText(R.string.review_close), null)
        if (sameOwner) dialog.setPositiveButton(if (MobileContentAdapter.canEditAsText(content)) mobileText(R.string.mobile_continue_editing) else mobileText(R.string.mobile_view_content)) { _, _ -> work {
            val latest = store.draft(draft.partition, draft.scope) ?: throw ProtocolFailure("OBJECT_DELETED")
            ui { if (owner() == partition) restore(latest, "") }
        } }
        if (MobileContentAdapter.canEditAsText(content) && MobileContentAdapter.text(content).isNotBlank()) dialog.setNeutralButton(mobileText(R.string.mobile_copy_text)) { _, _ -> work {
            val copy = store.edit(partition, "draft:${store.newId()}", JSONObject().put("content", MobileContentAdapter.textContent(MobileContentAdapter.text(content))))
            ui { if (owner() == partition) restore(copy, mobileText(R.string.mobile_new_draft_created)) }
        } }
        dialog.show()
    }
    private fun preview(value: JSONObject): String = MobileContentAdapter.summary(MobileContentAdapter.text(value.getJSONObject("content")), 500).ifBlank { mobileText(R.string.mobile_attachments_only_draft) }
    private fun summary(value: JSONObject): String = MobileContentAdapter.summary(preview(value).replace('\n', ' '), 80)
}
