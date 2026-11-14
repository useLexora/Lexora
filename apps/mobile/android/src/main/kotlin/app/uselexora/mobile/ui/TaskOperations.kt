package app.uselexora.mobile.ui

import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.R
import app.uselexora.mobile.protocol.MobileContentAdapter
import android.app.Activity
import android.app.AlertDialog
import app.uselexora.mobile.network.ProductClient
import app.uselexora.mobile.network.ApprovalDocuments
import app.uselexora.mobile.protocol.ApprovalReview
import app.uselexora.mobile.protocol.CommandOutbox
import app.uselexora.mobile.protocol.CommandReceipt
import app.uselexora.mobile.protocol.ConversationTarget
import app.uselexora.mobile.protocol.ProductIdentity
import app.uselexora.mobile.protocol.ProtocolFailure
import app.uselexora.mobile.protocol.ProtocolSchemas
import app.uselexora.mobile.protocol.ProductSubscription
import app.uselexora.mobile.storage.LocalStore
import org.json.JSONObject
import org.json.JSONArray

class TaskOperations(private val activity: Activity, private val store: LocalStore, private val client: () -> ProductClient, private val approvalDocuments: ApprovalDocuments, private val schemas: ProtocolSchemas,
    private val work: (() -> Unit) -> Unit, private val ui: (() -> Unit) -> Unit, private val changed: (JSONObject?) -> Unit) {
    private data class OperationOwner(val connection: ProductClient, val identity: ProductIdentity)
    private fun captureOwner(): OperationOwner? = runCatching { client().let { connection -> connection.identity?.let { OperationOwner(connection, it) } } }.getOrNull()
    private fun isCurrent(owner: OperationOwner): Boolean = owner.connection.isConnected && owner.connection.identity == owner.identity && runCatching { client() === owner.connection }.getOrDefault(false)
    private fun requireCurrent(owner: OperationOwner) { if (!isCurrent(owner)) throw ProtocolFailure("SOURCE_CHANGED") }
    private fun onOwner(expected: OperationOwner?, operation: (OperationOwner) -> Unit) = work {
        val owner = expected ?: throw ProtocolFailure("NOT_CONNECTED")
        requireCurrent(owner)
        operation(owner)
    }
    private var reviewSession: ApprovalDialog.Session? = null
    var onReadStateChanged: (JSONObject, Boolean) -> Unit = { _, _ -> }
    private var reviewSubscription: ProductSubscription? = null
    @Volatile private var reviewGeneration = 0L
    fun closeReview() { reviewGeneration++; reviewSession?.close(); reviewSession = null; reviewSubscription?.close(); reviewSubscription = null }
    fun approvals(cursor: String? = null): Unit = approvals(captureOwner(), cursor, null)
    fun approvalsForTask(conversationId: String, branchId: String? = null): Unit = approvals(captureOwner(), null, conversationId, branchId)
    private fun approvals(expected: OperationOwner?, cursor: String?, conversationId: String?, branchId: String? = null): Unit = onOwner(expected) { owner ->
        val params = JSONObject().put("status", "pending").put("cursor", cursor ?: JSONObject.NULL)
        conversationId?.let { params.put("conversationId", it) }
        branchId?.let { params.put("branchId", it) }
        val result = owner.connection.call("approvals.list", params)
        val items = result.getJSONArray("items")
        ui {
            if (!isCurrent(owner)) return@ui
            val dialog = AlertDialog.Builder(activity).setTitle(mobileText(R.string.mobile_operation_awaiting_review)).setItems((0 until items.length()).map { items.getJSONObject(it).getString("summary") }.toTypedArray()) { _, index -> review(owner, items.getJSONObject(index)) }.setNegativeButton(mobileText(R.string.review_close), null)
            if (!result.isNull("nextCursor")) dialog.setNeutralButton(mobileText(R.string.next_page)) { _, _ -> approvals(owner, result.getString("nextCursor"), conversationId, branchId) }
            dialog.show()
        }
    }
    fun review(approval: JSONObject) = review(captureOwner(), approval)
    private fun review(expected: OperationOwner?, approval: JSONObject) {
        closeReview()
        val generation = reviewGeneration
        onOwner(expected) { owner ->
            val current = owner.connection
            val fresh = approvalDocuments.get(current, approval.getString("id"))
            val conversationId = fresh.optString("conversationId").takeIf { it.isNotBlank() && it != "null" }
                ?: (current.callValue("runs.get", JSONObject().put("runId", fresh.getString("runId"))) as? JSONObject)?.getString("conversationId")
                ?: throw ProtocolFailure("OBJECT_DELETED")
            val task = current.callValue("conversations.get", JSONObject().put("conversationId", conversationId)) as? JSONObject ?: throw ProtocolFailure("OBJECT_DELETED")
            ui {
                if (generation != reviewGeneration || !isCurrent(owner)) return@ui
                val session = ApprovalDialog.show(activity, fresh, { current.serverNow() }, decide = { decision -> resolve(owner, fresh, decision, generation) }, onClosed = { if (generation == reviewGeneration) { reviewGeneration++; reviewSession = null; reviewSubscription?.close(); reviewSubscription = null } }, taskTitle = task.getString("title"))
                reviewSession = session
                session.setSynchronized(false)
                fun refresh() {
                    val latest = current.callValue("approvals.get", JSONObject().put("approvalId", fresh.getString("id"))) as? JSONObject
                    val attached = latest?.let { runCatching { ApprovalDocuments.attach(it, fresh) }.getOrNull() }
                    val decision = if (attached != null && attached.optString("status") != "pending" && current.supports("approvals.getDecision")) current.callValue("approvals.getDecision", JSONObject().put("approvalId", fresh.getString("id"))) as? JSONObject else null
                    ui { if (generation == reviewGeneration && isCurrent(owner)) { if (attached == null) session.invalidate(mobileText(R.string.review_changed)) else session.update(attached, decision) } }
                }
                reviewSubscription = ProductSubscription(current, schemas,
                    snapshot = { _, _ -> refresh() },
                    changes = { _, changes -> if (changes.any { it.optString("id") == fresh.getString("id") || it.optJSONObject("value")?.optString("id") == fresh.getString("id") }) refresh() },
                    state = { state -> ui { if (generation == reviewGeneration && isCurrent(owner)) session.setSynchronized(state == "SYNCHRONIZED") } })
                reviewSubscription!!.subscribe("approvalInbox")
            }
        }
    }
    private fun resolve(expected: OperationOwner, reviewed: JSONObject, decision: String, generation: Long) = onOwner(expected) { owner ->
        val current = owner.connection
        fun revisit() = ui { if (generation == reviewGeneration && isCurrent(owner)) review(owner, reviewed) }
        val id = reviewed.getString("id")
        val latest = current.callValue("approvals.get", JSONObject().put("approvalId", id)) as? JSONObject ?: throw ProtocolFailure("OBJECT_DELETED")
        if (latest.getString("status") != "pending") { revisit(); return@onOwner }
        val version = reviewed.getJSONObject("review").getString("reviewVersion")
        if (latest.optJSONObject("review")?.optString("reviewVersion") != version || latest.optString("runId") != reviewed.getString("runId") || decision !in ApprovalReview.decisions(ApprovalDocuments.attach(latest, reviewed), current.serverNow())) throw ProtocolFailure("REVIEW_CHANGED")
        val intent = JSONObject().put("approvalId", id).put("runId", reviewed.getString("runId")).put("reviewVersion", version).put("decision", decision)
        requireCurrent(owner)
        val receipt = CommandOutbox(store).submit(current, "approvals.resolve", intent)
        if (receipt.getString("decision") != "accepted") {
            if (receipt.optString("errorCode") == "APPROVAL_ALREADY_RESOLVED") { revisit(); return@onOwner }
            throw ProtocolFailure(receipt.optString("errorCode", "COMMAND_REJECTED"))
        }
        ui { if (isCurrent(owner)) changed(null) }
    }
    fun queue(task: ConversationTarget, cursor: String? = null): Unit = queue(captureOwner(), task, cursor)
    private fun queue(expected: OperationOwner?, task: ConversationTarget, cursor: String?): Unit = onOwner(expected) { owner ->
        val params = task.params().put("cursor", cursor ?: JSONObject.NULL)
        val result = owner.connection.call("chat.queue.list", params)
        val items = result.getJSONArray("items")
        ui {
            if (!isCurrent(owner)) return@ui
            val dialog = AlertDialog.Builder(activity).setTitle(mobileText(R.string.mobile_input_waiting_to_send)).setItems((0 until items.length()).map { val item = items.getJSONObject(it); "${if (item.getString("state") == "paused") mobileText(R.string.mobile_paused) else mobileText(R.string.mobile_queued)} · ${MobileContentAdapter.text(item.getJSONObject("content"))}" }.toTypedArray()) { _, index -> queueItem(owner, items.getJSONObject(index)) }.setNegativeButton(mobileText(R.string.review_close), null)
            if (!result.isNull("nextCursor")) dialog.setNeutralButton(mobileText(R.string.next_page)) { _, _ -> queue(owner, task, result.getString("nextCursor")) }
            dialog.show()
        }
    }
    private fun queueItem(owner: OperationOwner, item: JSONObject) {
        if (!isCurrent(owner)) return
        val actions = linkedMapOf<String, String>()
        if (item.optString("state") in setOf("waiting", "paused")) actions["chat.queue.cancel"] = mobileText(R.string.mobile_remove_this_input)
        if (item.optString("state") == "paused") actions["chat.queue.continue"] = mobileText(R.string.mobile_resume_this_input)
        val target = item.optJSONObject("steerTarget")
        if (item.optString("state") == "waiting" && target != null) actions["chat.queue.steer"] = mobileText(R.string.mobile_send_to_the_current_run)
        AlertDialog.Builder(activity).setTitle(mobileText(R.string.mobile_handle_loaded_input)).setItems(actions.values.toTypedArray()) { _, index ->
            val method = actions.keys.elementAt(index)
            val intent = JSONObject().put("conversationId", item.getString("conversationId")).put("branchId", item.getString("branchId")).put("id", item.getString("id")).put("expectedRevision", item.getString("revision"))
            if (method == "chat.queue.steer") intent.put("targetRunId", target!!.getString("runId")).put("expectedRunGeneration", target.getString("generation"))
            command(owner, method, intent)
        }.setNegativeButton(mobileText(R.string.review_close), null).show()
    }
    fun stopRun(run: JSONObject, onAccepted: (String) -> Unit) {
        val selected = JSONObject(run.toString())
        onOwner(captureOwner()) { owner ->
            val id = selected.getString("id")
            val generation = selected.getString("generation")
            ui {
                if (!isCurrent(owner)) return@ui
                AlertDialog.Builder(activity).setTitle(mobileText(R.string.mobile_stop_this_run))
                    .setMessage(mobileText(R.string.mobile_only_this_run_will_stop_queued_inputs_will_not))
                    .setNegativeButton(mobileText(R.string.label_cancel), null)
                    .setPositiveButton(mobileText(R.string.mobile_stop_run)) { _, _ ->
                        onOwner(owner) cancel@{ currentOwner ->
                            val current = currentOwner.connection.callValue("runs.get", JSONObject().put("runId", id)) as? JSONObject ?: throw ProtocolFailure("OBJECT_DELETED")
                            if (current.getString("generation") != generation || current.getString("conversationId") != selected.getString("conversationId") || current.getString("branchId") != selected.getString("branchId")) throw ProtocolFailure("SOURCE_CHANGED")
                            if (current.getString("status") !in setOf("queued", "running")) {
                                ui {
                                    if (isCurrent(currentOwner)) AlertDialog.Builder(activity).setTitle(mobileText(R.string.mobile_run_already_finished)).setMessage(mobileText(R.string.mobile_this_run_has_finished_and_no_longer_needs_to)).setPositiveButton(mobileText(R.string.review_close), null).show()
                                }
                                return@cancel
                            }
                            requireCurrent(currentOwner)
                            val intent = JSONObject().put("runId", id).put("expectedRunGeneration", generation)
                            val receipt = CommandOutbox(store).submit(currentOwner.connection, "chat.cancel", intent)
                            CommandReceipt.requireAccepted(receipt)
                            ui { if (isCurrent(currentOwner)) onAccepted(id) }
                        }
                    }.show()
            }
        }
    }
    fun runs(task: ConversationTarget, cursor: String? = null): Unit = runs(captureOwner(), task, cursor)
    private fun runs(expected: OperationOwner?, task: ConversationTarget, cursor: String?): Unit = onOwner(expected) { owner ->
        val result = owner.connection.call("runs.list", task.params().put("cursor", cursor ?: JSONObject.NULL))
        val items = result.getJSONArray("items")
        ui {
            if (!isCurrent(owner)) return@ui
            val dialog = AlertDialog.Builder(activity).setTitle(mobileText(R.string.mobile_task_run)).setItems((0 until items.length()).map { val run = items.getJSONObject(it); "${runStatus(run.getString("status"))} · ${run.getString("startedAt")}" }.toTypedArray()) { _, index ->
                showRun(owner, items.getJSONObject(index).getString("id"))
            }.setNegativeButton(mobileText(R.string.review_close), null)
            if (!result.isNull("nextCursor")) dialog.setNeutralButton(mobileText(R.string.next_page)) { _, _ -> runs(owner, task, result.getString("nextCursor")) }
            dialog.show()
        }
    }
    fun showRun(id: String, stopAccepted: Boolean = false): Unit = showRun(captureOwner(), id, stopAccepted)
    private fun showRun(expected: OperationOwner?, id: String, stopAccepted: Boolean = false): Unit = onOwner(expected) { owner ->
        val current = owner.connection
        val run = current.callValue("runs.get", JSONObject().put("runId", id)) as? JSONObject ?: throw ProtocolFailure("OBJECT_DELETED")
        val execution = if (current.supports("runs.getExecutionState")) current.callValue("runs.getExecutionState", JSONObject().put("runId", id)) as? JSONObject else null
        if (execution != null && execution.getString("generation") != run.getString("generation")) throw ProtocolFailure("SOURCE_CHANGED")
        val resources = when (execution?.optString("resources")) { "released" -> mobileText(R.string.mobile_released); "occupied" -> mobileText(R.string.mobile_still_in_use); else -> mobileText(R.string.mobile_not_yet_confirmed) }
        val phase = when (execution?.optString("phase")) { "queued" -> mobileText(R.string.mobile_queued); "preparing" -> mobileText(R.string.mobile_preparing); "working" -> mobileText(R.string.mobile_running); "waiting" -> mobileText(R.string.mobile_waiting); "closing" -> mobileText(R.string.mobile_finishing); "closed" -> mobileText(R.string.mobile_finished); else -> mobileText(R.string.unknown) }
        val details = mobileText(R.string.mobile_run_execution_phase_service_resources, runStatus(run.getString("status")), phase, resources) + if (execution?.optBoolean("cancelRequested") == true || stopAccepted) mobileText(R.string.mobile_stop_request_accepted_check_the_current_status_to_confirm) else ""
        ui {
            if (!isCurrent(owner)) return@ui
            val dialog = AlertDialog.Builder(activity).setTitle(if (stopAccepted) mobileText(R.string.mobile_stop_request_accepted) else mobileText(R.string.mobile_this_run)).setMessage(details).setNegativeButton(mobileText(R.string.review_close), null).setNeutralButton(mobileText(R.string.mobile_refresh_status)) { _, _ -> showRun(owner, id) }
            if (run.getString("status") in setOf("queued", "running") && execution?.optBoolean("cancelRequested") != true) dialog.setPositiveButton(mobileText(R.string.mobile_stop_run)) { _, _ ->
                AlertDialog.Builder(activity).setTitle(mobileText(R.string.mobile_stop_this_run)).setMessage(mobileText(R.string.mobile_only_the_selected_run_will_stop_queued_inputs_will)).setPositiveButton(mobileText(R.string.mobile_stop_run)) { _, _ -> command(owner, "chat.cancel", JSONObject().put("runId", id).put("expectedRunGeneration", run.getString("generation"))) }.setNegativeButton(mobileText(R.string.label_cancel), null).show()
            } else if (run.getString("status") !in setOf("queued", "running") && (execution == null || execution.optString("resources") == "released")) dialog.setPositiveButton(mobileText(R.string.label_regenerate)) { _, _ ->
                AlertDialog.Builder(activity).setTitle(mobileText(R.string.mobile_regenerate_this_reply)).setMessage(mobileText(R.string.mobile_a_new_reply_will_be_generated_from_this_run)).setPositiveButton(mobileText(R.string.label_regenerate)) { _, _ -> command(owner, "chat.regenerateAssistant", JSONObject().put("conversationId", run.getString("conversationId")).put("sourceRunId", id)) }.setNegativeButton(mobileText(R.string.label_cancel), null).show()
            }
            dialog.show()
        }
    }
    private fun runStatus(value: String) = when (value) { "queued" -> mobileText(R.string.mobile_queued); "running" -> mobileText(R.string.mobile_running_2); "completed" -> mobileText(R.string.mobile_completed); "failed" -> mobileText(R.string.mobile_execution_failed); "cancelled" -> mobileText(R.string.mobile_cancelled); else -> mobileText(R.string.mobile_unknown_status) }
    fun readState(task: JSONObject): Unit = onOwner(captureOwner()) { owner ->
        val items = owner.connection.callValue("taskMarks.states", JSONObject().put("conversationIds", JSONArray().put(task.getString("id")))) as? JSONArray ?: throw ProtocolFailure("PROTOCOL_INCOMPATIBLE")
        val state = (0 until items.length()).map { items.getJSONObject(it) }.firstOrNull { it.getString("conversationId") == task.getString("id") } ?: throw ProtocolFailure("OBJECT_DELETED")
        ui {
            if (!isCurrent(owner)) return@ui
            AlertDialog.Builder(activity).setTitle(if (state.getBoolean("unread")) mobileText(R.string.mobile_this_task_has_unread_results) else mobileText(R.string.mobile_this_task_has_been_read)).setMessage(task.optString("title")).setPositiveButton(if (state.getBoolean("unread")) mobileText(R.string.mobile_mark_as_read) else mobileText(R.string.mobile_mark_as_unread)) { _, _ ->
                if (!isCurrent(owner)) return@setPositiveButton
                onReadStateChanged(state, state.getBoolean("unread"))
                command(owner, "taskMarks.setRead", JSONObject().put("conversationId", state.getString("conversationId")).put("resultRunId", state.get("resultRunId")).put("readRevision", state.getString("readRevision")).put("read", state.getBoolean("unread")))
            }.setNegativeButton(mobileText(R.string.review_close), null).show()
        }
    }
    fun command(method: String, intent: JSONObject) = command(captureOwner(), method, intent)
    private fun command(expected: OperationOwner?, method: String, intent: JSONObject) = onOwner(expected) { owner ->
        requireCurrent(owner)
        val receipt = CommandOutbox(store).submit(owner.connection, method, intent)
        CommandReceipt.requireAccepted(receipt)
        ui {
            if (!isCurrent(owner)) return@ui
            changed(if (method in setOf("chat.regenerateAssistant", "conversations.activateBranch")) receipt else null)
            if (method == "chat.cancel") showRun(owner, intent.getString("runId"), true)
            else if (method == "chat.queue.steer") AlertDialog.Builder(activity).setTitle(mobileText(R.string.mobile_supplement_request_accepted)).setMessage(mobileText(R.string.mobile_the_supplement_request_for_this_run_was_recorded_check)).setPositiveButton(mobileText(R.string.review_close), null).show()
        }
    }
}
