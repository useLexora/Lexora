package app.uselexora.mobile.ui

import android.app.Activity
import android.app.AlertDialog
import app.uselexora.mobile.R
import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.network.ProductClient
import app.uselexora.mobile.protocol.CommandOutbox
import app.uselexora.mobile.protocol.CommandRecovery
import app.uselexora.mobile.protocol.ProtocolFailure
import app.uselexora.mobile.session.MobileOperationFailure
import app.uselexora.mobile.storage.LocalStore
import app.uselexora.mobile.storage.OutboxItem
import org.json.JSONObject

internal class CommandHistoryPanel(
    private val activity: Activity,
    private val store: LocalStore,
    private val owner: () -> String,
    private val client: () -> ProductClient?,
    private val read: (() -> Unit) -> Unit,
    private val work: (() -> Unit) -> Unit,
    private val ui: (() -> Unit) -> Unit,
    private val targetLabel: (OutboxItem) -> String,
    private val openTarget: (OutboxItem) -> Unit,
    private val restore: (OutboxItem) -> Unit,
    private val reviewApproval: (JSONObject) -> Unit,
    private val changed: (OutboxItem) -> Unit,
) {
    private var generation = 0L
    fun show() {
        val partition = owner()
        val request = ++generation
        read {
            try {
                val items = store.outbox(partition)
                ui {
                    if (!current(partition, request)) return@ui
                    val dialog = AlertDialog.Builder(activity).setTitle(mobileText(R.string.label_send_history))
                        .setNegativeButton(mobileText(R.string.review_close)) { _, _ -> generation++ }
                        .setOnCancelListener { generation++ }
                    if (items.isEmpty()) dialog.setMessage(mobileText(R.string.command_history_empty))
                    else dialog.setItems(items.map { "${label(it)} · ${state(it.state)}\n${targetLabel(it)}" }.toTypedArray()) { _, index ->
                        if (current(partition, request)) detail(items[index])
                    }
                    dialog.show()
                }
            } catch (error: Exception) { ui { if (current(partition, request)) failure(error) { show() } } }
        }
    }
    private fun current(partition: String, request: Long) = owner() == partition && generation == request && !activity.isFinishing
    private fun detail(snapshot: OutboxItem, notice: String? = null) {
        val request = ++generation
        read {
            val item = store.outbox(snapshot.partition).firstOrNull { it.id == snapshot.id } ?: return@read
            val hasInput = CommandHistoryTarget.originalScope(item)?.let { store.draft(item.partition, it) } != null
            ui {
                if (!current(item.partition, request)) return@ui
                val connection = client()?.takeIf { it.isConnected && it.identity?.partition == item.partition }
                val recovery = connection?.let { CommandRecovery.forItem(item, it.identity?.serviceInstanceId) } ?: CommandRecovery.CheckReceipt
                val explanation = when {
                    item.state == "accepted" -> mobileText(R.string.mobile_the_service_received_this_operation_open_the_task_to)
                    item.state == "rejected" -> mobileText(R.string.mobile_this_operation_was_not_executed_your_input_is_retained)
                    recovery == CommandRecovery.ReviewTask -> mobileText(R.string.mobile_the_service_restarted_and_has_no_receipt_for_this)
                    item.state == "not_found" -> mobileText(R.string.command_no_record_hint)
                    else -> mobileText(R.string.mobile_the_result_is_still_unknown_check_again_later_no)
                }
                val rejection = item.receipt?.optString("errorCode")?.takeIf { item.state == "rejected" && it.isNotBlank() && it != "null" }
                    ?.let { MobileFailurePresentation.message(MobileOperationFailure.from(ProtocolFailure(it))) }
                val message = listOfNotNull(targetLabel(item), explanation, rejection, notice,
                    mobileText(R.string.command_record_identifier, item.id)).joinToString("\n\n")
                val dialog = AlertDialog.Builder(activity).setTitle("${label(item)} · ${state(item.state)}").setMessage(message)
                    .setNegativeButton(mobileText(R.string.review_close)) { _, _ -> generation++ }
                    .setOnCancelListener { generation++ }
                if (item.state == "accepted" && CommandHistoryTarget.target(item) != null) {
                    dialog.setPositiveButton(mobileText(R.string.command_view_target)) { _, _ -> if (current(item.partition, request)) openTarget(item) }
                } else if (item.state == "rejected" && hasInput) {
                    dialog.setPositiveButton(mobileText(R.string.command_return_to_input)) { _, _ -> if (current(item.partition, request)) restore(item) }
                } else if (item.state !in setOf("accepted", "rejected")) {
                    dialog.setPositiveButton(mobileText(R.string.command_check_receipt)) { _, _ -> if (current(item.partition, request)) recover(item, false) }
                    when {
                        recovery == CommandRecovery.RetryOriginal -> dialog.setNeutralButton(mobileText(R.string.command_retry_original)) { _, _ -> if (current(item.partition, request)) recover(item, true) }
                        recovery == CommandRecovery.ReviewApproval -> dialog.setNeutralButton(mobileText(R.string.mobile_reload_approval)) { _, _ -> if (current(item.partition, request)) reloadApproval(item) }
                        recovery == CommandRecovery.ReviewTask && CommandHistoryTarget.target(item) != null -> dialog.setNeutralButton(mobileText(R.string.command_view_target)) { _, _ -> if (current(item.partition, request)) openTarget(item) }
                    }
                }
                dialog.show()
            }
        }
    }
    private fun recover(item: OutboxItem, retry: Boolean) {
        val request = ++generation
        val connection = client()
        val waiting = AlertDialog.Builder(activity).setTitle(mobileText(R.string.command_check_receipt))
            .setMessage(mobileText(R.string.command_checking_receipt)).setNegativeButton(mobileText(R.string.review_close)) { _, _ -> generation++ }
            .setOnCancelListener { generation++ }.show()
        work {
            val result = runCatching {
                requireConnection(item, connection)
                val latest = store.outbox(item.partition).firstOrNull { it.id == item.id } ?: throw ProtocolFailure("OBJECT_DELETED")
                if (latest.state !in setOf("accepted", "rejected")) {
                    if (retry) CommandOutbox(store).retry(connection!!, latest) else CommandOutbox(store).reconcile(connection!!, latest)
                }
                store.outbox(item.partition).first { it.id == item.id }
            }
            ui {
                waiting.dismiss()
                result.getOrNull()?.let(changed)
                if (!current(item.partition, request) || client() !== connection) return@ui
                detail(item, result.exceptionOrNull()?.let { MobileFailurePresentation.message(MobileOperationFailure.from(it)) })
            }
        }
    }
    private fun reloadApproval(item: OutboxItem) {
        val request = ++generation
        val connection = client()
        work {
            val result = runCatching {
                requireConnection(item, connection)
                connection!!.call("approvals.get", JSONObject().put("approvalId", item.envelope.getJSONObject("intent").getString("approvalId")))
            }
            ui {
                if (!current(item.partition, request) || client() !== connection) return@ui
                result.fold(reviewApproval) { detail(item, MobileFailurePresentation.message(MobileOperationFailure.from(it))) }
            }
        }
    }
    private fun requireConnection(item: OutboxItem, connection: ProductClient?) {
        if (owner() != item.partition || client() !== connection) throw ProtocolFailure("SOURCE_CHANGED")
        if (connection?.isConnected != true) throw ProtocolFailure("NOT_CONNECTED")
        if (connection.identity?.partition != item.partition) throw ProtocolFailure("DATA_GENERATION_CHANGED")
    }
    private fun failure(error: Exception, retry: () -> Unit) {
        AlertDialog.Builder(activity).setMessage(MobileFailurePresentation.message(MobileOperationFailure.from(error)))
            .setNegativeButton(mobileText(R.string.review_close), null).setPositiveButton(mobileText(R.string.label_retry)) { _, _ -> retry() }.show()
    }
    private fun label(item: OutboxItem): String = when (item.method) {
        "chat.submitInput" -> when (item.envelope.optJSONObject("intent")?.optString("operation")) {
            "edit" -> mobileText(R.string.mobile_edit_previous_input)
            "enqueue" -> mobileText(R.string.mobile_add_to_send_queue)
            else -> mobileText(R.string.mobile_send_task)
        }
        "chat.startTurn" -> mobileText(R.string.mobile_send_task)
        "chat.editUserMessage" -> mobileText(R.string.mobile_edit_previous_input)
        "chat.regenerateAssistant" -> mobileText(R.string.label_regenerate)
        "chat.cancel" -> mobileText(R.string.mobile_stop_run)
        "chat.queue.enqueue" -> mobileText(R.string.mobile_add_to_send_queue)
        "chat.queue.cancel" -> mobileText(R.string.mobile_remove_queued_input)
        "chat.queue.steer" -> mobileText(R.string.mobile_supplement_current_run)
        "chat.queue.continue" -> mobileText(R.string.mobile_resume_queued_input)
        "composerDrafts.open", "composerDrafts.save" -> mobileText(R.string.mobile_save_draft)
        "composerDrafts.copy" -> mobileText(R.string.mobile_copy_draft)
        "composerDrafts.discard" -> mobileText(R.string.mobile_delete_desktop_draft)
        "uploads.create", "uploads.stage", "uploads.complete", "uploads.adopt" -> mobileText(R.string.label_add_attachment)
        "uploads.cancel" -> mobileText(R.string.mobile_cancel_upload)
        "approvals.resolve" -> mobileText(R.string.mobile_handle_approval)
        "questions.answer" -> mobileText(R.string.mobile_answer_question)
        "questions.cancel" -> mobileText(R.string.mobile_skip_question)
        "questions.retry" -> mobileText(R.string.mobile_redeliver_answer)
        "conversations.activateBranch" -> mobileText(R.string.mobile_switch_history_branch)
        "desktop.open" -> mobileText(R.string.label_open_on_desktop)
        else -> mobileText(R.string.mobile_task_action)
    }
    private fun state(state: String): String = mobileText(when (state) {
        "accepted" -> R.string.mobile_received_by_service
        "rejected" -> R.string.mobile_not_executed
        "prepared" -> R.string.mobile_waiting_to_send
        "not_found" -> R.string.mobile_no_record_found
        else -> R.string.mobile_result_unconfirmed
    })
}
