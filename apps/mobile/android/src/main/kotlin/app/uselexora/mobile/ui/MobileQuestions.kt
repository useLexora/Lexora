package app.uselexora.mobile.ui

import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.R
import android.app.Activity
import android.app.AlertDialog
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.text.Editable
import android.text.TextWatcher
import android.view.View
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import app.uselexora.mobile.network.ProductClient
import app.uselexora.mobile.protocol.CommandOutbox
import app.uselexora.mobile.protocol.ProductProjection
import app.uselexora.mobile.protocol.ProductSubscription
import app.uselexora.mobile.protocol.ProtocolFailure
import app.uselexora.mobile.protocol.ProtocolSchemas
import app.uselexora.mobile.storage.LocalStore
import app.uselexora.mobile.storage.OutboxItem
import app.uselexora.mobile.session.MobileOperationFailure
import org.json.JSONArray
import org.json.JSONObject

class MobileQuestions(
    private val activity: Activity,
    private val store: LocalStore,
    private val schemas: ProtocolSchemas,
    private val work: (() -> Unit) -> Unit,
    private val ui: (() -> Unit) -> Unit,
    private val changed: (List<JSONObject>) -> Unit,
    private val notice: (String) -> Unit,
) {
    private data class Owner(val client: ProductClient, val partition: String, val conversationId: String, val branchId: String)
    private var owner: Owner? = null
    private var subscription: ProductSubscription? = null
    private var dialog: AlertDialog? = null
    private var openId: String? = null
    private var panelFailure: ((String) -> Unit)? = null
    private val drafts = activity.getSharedPreferences("question-inputs", Activity.MODE_PRIVATE)

    fun bind(client: ProductClient?, conversationId: String?, branchId: String?) {
        val next = if (client?.isConnected == true && client.supports("questions.list") && conversationId != null && branchId != null)
            Owner(client, client.identity!!.partition, conversationId, branchId) else null
        if (next == owner) return
        close()
        owner = next
        changed(emptyList())
        if (next == null) return
        val projection = ProductProjection()
        val topic = "questions:${android.net.Uri.encode(next.conversationId)}:${android.net.Uri.encode(next.branchId)}"
        fun publish() = ui {
            if (!current(next)) return@ui
            val items = projection.items()
            changed(items)
            val opened = openId
            if (opened != null && items.firstOrNull { it.optString("id") == opened }?.optString("status") != "pending") {
                dialog?.dismiss(); dialog = null; openId = null
                notice(if (items.any { it.optString("id") == opened }) mobileText(R.string.question_handled_elsewhere) else mobileText(R.string.question_unavailable))
            }
        }
        subscription = ProductSubscription(next.client, schemas,
            snapshot = { received, items -> projection.snapshot(received, items); publish() },
            changes = { received, changes -> projection.apply(received, changes); publish() },
            state = { state -> if (state !in setOf("SYNCING", "SYNCHRONIZED")) ui {
                if (owner === next) {
                    val message = mobileText(R.string.question_sync_failed)
                    panelFailure?.invoke(message) ?: notice(message)
                }
            } })
        subscription!!.subscribe(topic)
    }

    fun close() {
        owner = null
        subscription?.close(); subscription = null
        dialog?.dismiss(); dialog = null; openId = null; panelFailure = null
    }

    fun show(question: JSONObject) {
        val expected = owner ?: return
        if (!current(expected) || question.optString("conversationId") != expected.conversationId || question.optString("branchId") != expected.branchId) return
        val snapshot = JSONObject(question.toString())
        if (snapshot.optString("status") != "pending") {
            val failed = snapshot.optJSONObject("delivery")?.optString("state") == "failed"
            val delivery = snapshot.optJSONObject("delivery")?.optString("state")
            val resultName = if (snapshot.optString("status") == "cancelled") mobileText(R.string.question_skip_response) else mobileText(R.string.question_answers)
            val stateLabel = when {
                failed -> mobileText(R.string.question_response_saved, resultName)
                delivery == "pending" -> mobileText(R.string.question_response_pending, resultName)
                snapshot.optString("status") == "cancelled" -> mobileText(R.string.question_cancelled)
                snapshot.optString("status") == "interrupted" -> mobileText(R.string.question_interrupted)
                else -> mobileText(R.string.question_delivered)
            }
            val answers = snapshot.optJSONObject("response")?.optJSONArray("answers")
            val values = snapshot.getJSONArray("questions")
            val transcript = (0 until values.length()).joinToString("\n\n") { index ->
                val item = values.getJSONObject(index)
                val answer = answers?.let { records -> (0 until records.length()).map { records.getJSONObject(it) }.firstOrNull { it.optString("questionId") == item.getString("id") } }
                val selected = answer?.optJSONArray("selectedOptionIds")?.let { ids -> (0 until ids.length()).map { ids.getString(it) }.toSet() }.orEmpty()
                val options = item.getJSONArray("options")
                val labels = (0 until options.length()).map { options.getJSONObject(it) }.filter { it.getString("id") in selected }.map { it.getString("label") }
                item.getString("question") + "\n" + (labels + listOfNotNull(answer?.optString("text")?.takeIf { it.isNotBlank() })).joinToString("\n")
            }
            dialog?.dismiss()
            val content = TextView(activity).apply { text = "$stateLabel\n\n$transcript"; textSize = 16f; setPadding(dp(24), dp(12), dp(24), dp(16)); setTextIsSelectable(true) }
            val builder = AlertDialog.Builder(activity).setTitle(mobileText(R.string.label_questions_answers)).setView(ScrollView(activity).apply { addView(content) })
                .setNegativeButton(mobileText(R.string.review_close), null)
            if (failed && expected.client.supports("questions.retry")) builder.setPositiveButton(mobileText(R.string.question_retry), null)
            dialog = builder.create().also { shown ->
                shown.setOnDismissListener { if (dialog === shown) { dialog = null; panelFailure = null } }
                shown.show(); shown.expandForMobileReview()
                panelFailure = { message -> content.text = "$message\n\n$stateLabel\n\n$transcript" }
                if (failed && expected.client.supports("questions.retry")) shown.getButton(AlertDialog.BUTTON_POSITIVE).apply {
                    setOnClickListener {
                        isEnabled = false
                        content.text = "${mobileText(R.string.question_submitting)}\n\n$transcript"
                        submit(expected, snapshot, "questions.retry", null) { error ->
                            if (dialog === shown && shown.isShowing) {
                                if (error == null) shown.dismiss()
                                else {
                                    isEnabled = true
                                    text = if (error.code == "COMMAND_RESULT_UNKNOWN") mobileText(R.string.question_check_status) else mobileText(R.string.question_retry)
                                    panelFailure?.invoke(MobileFailurePresentation.message(error))
                                }
                            }
                        }
                    }
                }
            }
            return
        }
        dialog?.dismiss()
        openId = snapshot.getString("id")
        val key = "${expected.partition}:${snapshot.getString("id")}"
        val saved = drafts.getString(key, null)?.let { runCatching { JSONObject(it) }.getOrNull() }
        val questions = snapshot.getJSONArray("questions")
        val answers = JSONArray()
        val controls = mutableListOf<View>()
        var busy = false
        var checkingOriginal = false
        val layout = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(24), dp(8), dp(24), dp(12)) }
        val feedback = TextView(activity).apply { textSize = 14f; visibility = View.GONE; accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE }
        layout.addView(feedback)
        fun valid(): Boolean = (0 until answers.length()).all { index ->
            val answer = answers.getJSONObject(index)
            answer.getJSONArray("selectedOptionIds").length() > 0 || answer.optString("text").isNotBlank()
        }
        fun updateControls() {
            controls.forEach { it.isEnabled = !busy && !checkingOriginal }
            dialog?.getButton(AlertDialog.BUTTON_POSITIVE)?.apply {
                isEnabled = !busy && (checkingOriginal || valid())
                text = mobileText(if (checkingOriginal) R.string.question_check_status else R.string.question_submit)
            }
            dialog?.getButton(AlertDialog.BUTTON_NEUTRAL)?.isEnabled = !busy && !checkingOriginal
        }
        fun persist() {
            drafts.edit().putString(key, JSONObject().put("answers", answers).toString()).apply()
            updateControls()
        }
        for (index in 0 until questions.length()) {
            val item = questions.getJSONObject(index)
            val id = item.getString("id")
            val options = item.getJSONArray("options")
            val existing = saved?.optJSONArray("answers")?.let { values -> (0 until values.length()).map { values.getJSONObject(it) }.firstOrNull { it.optString("questionId") == id } }
            val selected = linkedSetOf<String>()
            val allowed = (0 until options.length()).map { options.getJSONObject(it).getString("id") }.toSet()
            existing?.optJSONArray("selectedOptionIds")?.let { values -> (0 until values.length()).map { values.getString(it) }.filter { it in allowed }.forEach(selected::add) }
            if (item.getString("kind") == "single" && selected.size > 1) { val first = selected.first(); selected.clear(); selected.add(first) }
            val answer = JSONObject().put("questionId", id).put("selectedOptionIds", JSONArray(selected.toList())).put("text", existing?.optString("text").orEmpty())
            answers.put(answer)
            layout.addView(TextView(activity).apply { text = item.getString("question"); textSize = 17f; setPadding(0, dp(12), 0, dp(12)) })
            val choices = mutableListOf<Pair<String, CheckBox>>()
            for (optionIndex in 0 until options.length()) {
                val option = options.getJSONObject(optionIndex)
                val optionId = option.getString("id")
                val choice = CheckBox(activity).apply {
                    text = option.getString("label") + (if (option.optBoolean("recommended")) mobileText(R.string.question_recommended) else "") + option.optString("description").takeIf { it.isNotBlank() }?.let { "\n$it" }.orEmpty()
                    textSize = 15f; minHeight = dp(48); setPadding(0, dp(8), 0, dp(8)); isChecked = optionId in selected
                }
                choices.add(optionId to choice); controls.add(choice); layout.addView(choice)
                choice.setOnClickListener {
                    if (item.getString("kind") == "single") {
                        selected.clear()
                        if (choice.isChecked) selected.add(optionId)
                        choices.forEach { (other, check) -> check.isChecked = other in selected }
                    } else if (choice.isChecked) selected.add(optionId) else selected.remove(optionId)
                    answer.put("selectedOptionIds", JSONArray(selected.toList())); persist()
                }
            }
            val input = EditText(activity).apply {
                hint = if (item.getString("kind") == "text") mobileText(R.string.question_write) else mobileText(R.string.question_extra)
                textSize = 16f; minLines = 1; maxLines = 5
                inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE
                filters = arrayOf(android.text.InputFilter.LengthFilter(8000))
                setText(answer.getString("text"))
                addTextChangedListener(object : TextWatcher {
                    override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                    override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
                    override fun afterTextChanged(s: Editable?) { answer.put("text", s?.toString().orEmpty()); persist() }
                })
            }
            controls.add(input); layout.addView(input)
        }
        val scroll = ScrollView(activity).apply { isFillViewport = false; addView(layout) }
        val builder = AlertDialog.Builder(activity).setTitle(mobileText(R.string.confirm_question, snapshot.optString("buddyName").takeIf { it.isNotBlank() } ?: "Lexora"))
            .setView(scroll).setNegativeButton(mobileText(R.string.question_later), null).setPositiveButton(mobileText(R.string.question_submit), null)
        if (expected.client.supports("questions.cancel")) builder.setNeutralButton(mobileText(R.string.question_decline), null)
        dialog = builder.create().also { shown ->
            var confirmation: AlertDialog? = null
            shown.setOnDismissListener { confirmation?.dismiss(); if (dialog === shown) { dialog = null; openId = null; panelFailure = null } }
            shown.show()
            shown.expandForMobileReview()
            panelFailure = { message -> feedback.text = message; feedback.visibility = View.VISIBLE; scroll.smoothScrollTo(0, 0) }
            fun send(method: String, response: JSONObject?) {
                if (busy) return
                busy = true
                panelFailure?.invoke(mobileText(R.string.question_submitting))
                updateControls()
                submit(expected, snapshot, method, response) { error ->
                    if (dialog === shown && shown.isShowing) {
                        busy = false
                        if (error == null) shown.dismiss()
                        else {
                            checkingOriginal = error.code in setOf("COMMAND_RESULT_UNKNOWN", "SERVICE_INSTANCE_CHANGED", "DATA_GENERATION_CHANGED")
                            panelFailure?.invoke(MobileFailurePresentation.message(error))
                            updateControls()
                        }
                    }
                }
            }
            if (expected.client.supports("questions.cancel")) shown.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener {
                if (busy || checkingOriginal) return@setOnClickListener
                confirmation = AlertDialog.Builder(activity).setTitle(mobileText(R.string.question_skip_title)).setMessage(mobileText(R.string.question_skip_explanation))
                    .setNegativeButton(mobileText(R.string.label_back), null).setPositiveButton(mobileText(R.string.question_skip)) { _, _ -> send("questions.cancel", null) }.show()
            }
            shown.getButton(AlertDialog.BUTTON_POSITIVE).apply {
                val dark = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
                val accent = Color.parseColor(if (dark) "#91ABCC" else "#567993")
                val states = arrayOf(intArrayOf(android.R.attr.state_enabled), intArrayOf())
                val fill = ColorStateList(states, intArrayOf(accent, Color.parseColor(if (dark) "#414A45" else "#E5EAE4")))
                background = RippleDrawable(ColorStateList.valueOf(0x22FFFFFF), GradientDrawable().apply { cornerRadius = dp(12).toFloat(); setColor(fill) }, null)
                setTextColor(ColorStateList(states, intArrayOf(Color.parseColor(if (dark) "#202422" else "#FFFFFF"), Color.parseColor(if (dark) "#AAB1AB" else "#68786E"))))
                setPadding(dp(16), dp(8), dp(16), dp(8))
                isEnabled = valid()
                setOnClickListener {
                    if (!valid() && !checkingOriginal) return@setOnClickListener
                    send("questions.answer", JSONObject().put("answers", JSONArray(answers.toString())))
                }
            }
        }
    }

    private fun submit(expected: Owner, question: JSONObject, method: String, response: JSONObject?, complete: (MobileOperationFailure?) -> Unit) {
        val captured = response?.let { JSONObject(it.toString()) }
        work {
            try {
                requireCurrent(expected)
                val requestId = question.getString("id")
                val pending = MobileQuestionCommands.pending(store.outbox(expected.partition), expected.partition, expected.conversationId, expected.branchId, requestId)
                val actualMethod = pending?.method ?: method
                val actualResponse = if (pending == null) captured else pending.envelope.getJSONObject("intent").optJSONArray("answers")?.let { JSONObject().put("answers", JSONArray(it.toString())) }
                val outbox = CommandOutbox(store)
                val receipt = if (pending != null) outbox.retry(expected.client, pending) else {
                    val intent = JSONObject().put("conversationId", expected.conversationId).put("branchId", expected.branchId).put("requestId", requestId)
                    captured?.let { intent.put("answers", it.getJSONArray("answers")) }
                    outbox.submit(expected.client, method, intent)
                }
                if (receipt.optString("decision") != "accepted") throw ProtocolFailure(receipt.optString("errorCode", "COMMAND_REJECTED"))
                val key = "${expected.partition}:$requestId"
                if (actualResponse != null && drafts.getString(key, null) == actualResponse.toString()) drafts.edit().remove(key).apply()
                ui {
                    if (owner === expected) {
                        complete(null)
                        if (current(expected)) notice(if (actualMethod == "questions.cancel") mobileText(R.string.mobile_skip_choice_submitted) else mobileText(R.string.mobile_answer_submitted))
                    }
                }
            } catch (error: Exception) {
                val failure = MobileOperationFailure.from(error)
                ui { if (owner === expected) complete(failure) }
            }
        }
    }
    private fun current(expected: Owner) = owner === expected && expected.client.isConnected && expected.client.identity?.partition == expected.partition
    private fun requireCurrent(expected: Owner) { if (!current(expected)) throw ProtocolFailure("SOURCE_CHANGED") }
    private fun dp(value: Int) = (activity.resources.displayMetrics.density * value).toInt()
}

internal object MobileQuestionCommands {
    fun pending(items: List<OutboxItem>, partition: String, conversationId: String, branchId: String, requestId: String): OutboxItem? = items.firstOrNull { item ->
        item.partition == partition && item.state !in setOf("accepted", "rejected") && item.method in setOf("questions.answer", "questions.cancel", "questions.retry") &&
            item.envelope.optJSONObject("intent")?.let { intent ->
                intent.optString("conversationId") == conversationId && intent.optString("branchId") == branchId && intent.optString("requestId") == requestId
            } == true
    }
}
