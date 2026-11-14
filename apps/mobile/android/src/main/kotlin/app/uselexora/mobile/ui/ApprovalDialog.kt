package app.uselexora.mobile.ui

import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.R
import android.app.Activity
import android.app.AlertDialog
import android.graphics.Color
import android.graphics.Typeface
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import app.uselexora.mobile.protocol.ApprovalReview
import org.json.JSONObject
import java.time.Duration
import java.time.Instant

object ApprovalDialog {
    fun show(activity: Activity, approval: JSONObject, now: () -> Instant, decide: (String) -> Unit, onClosed: () -> Unit = {}, taskTitle: String? = null): Session = Session(activity, approval, now, decide, onClosed, taskTitle)

    class Session(private val activity: Activity, approval: JSONObject, private val now: () -> Instant, private val decide: (String) -> Unit, private val onClosed: () -> Unit, private val taskTitle: String?) {
        private var snapshot = JSONObject(approval.toString())
        private var outcome: JSONObject? = null
        private var synchronized = true
        private var invalid: String? = null
        private var closed = false
        private var details: AlertDialog? = null
        private val handler = Handler(Looper.getMainLooper())
        private val expiry = Runnable { render() }
        private val layout = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL; setPadding(32, 16, 32, 16) }
        private val dialog = AlertDialog.Builder(activity).setTitle(snapshot.getString("summary"))
            .setView(ScrollView(activity).apply { addView(layout) }).setNegativeButton(mobileText(R.string.review_close), null)
            .setNeutralButton(mobileText(R.string.review_technical), null).create()
        init {
            dialog.setOnDismissListener { close() }
            dialog.show()
            dialog.expandForMobileReview()
            dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener { showDetails() }
            render()
        }
        fun update(latest: JSONObject, decision: JSONObject? = null) {
            if (closed) return
            if (listOf("id", "runId", "kind").any { latest.optString(it) != snapshot.optString(it) } || latest.optJSONObject("review")?.optString("reviewVersion") != snapshot.optJSONObject("review")?.optString("reviewVersion")) {
                invalidate(mobileText(R.string.review_changed))
                return
            }
            snapshot = JSONObject(latest.toString())
            outcome = decision?.let { JSONObject(it.toString()) }
            render()
        }
        fun setSynchronized(value: Boolean) { if (!closed) { synchronized = value; render() } }
        fun invalidate(message: String = mobileText(R.string.review_invalid)) {
            if (closed) return
            invalid = message; render()
        }
        fun close() {
            if (closed) return
            closed = true
            handler.removeCallbacks(expiry)
            details?.dismiss(); details = null
            dialog.dismiss()
            onClosed()
        }
        private fun decisions() = if (!synchronized || invalid != null) emptyList() else runCatching { ApprovalReview.decisions(snapshot, now()) }.getOrDefault(emptyList())
        private fun render() {
            if (closed) return
            handler.removeCallbacks(expiry)
            val remaining = runCatching { Duration.between(now(), Instant.parse(snapshot.getJSONObject("review").getString("expiresAt"))).toMillis() }.getOrNull()
            val notice = invalid ?: when {
                remaining == null -> mobileText(R.string.review_invalid)
                snapshot.optString("status") != "pending" -> null
                remaining <= 0 -> mobileText(R.string.review_expired)
                !synchronized -> mobileText(R.string.review_syncing)
                else -> null
            }
            layout.removeAllViews()
            val sections = listOfNotNull(taskTitle?.takeIf { it.isNotBlank() }?.let { mobileText(R.string.review_task) to it }) + ApprovalReview.sections(snapshot, outcome) + listOfNotNull(notice?.let { mobileText(R.string.review_status) to it })
            for ((label, value) in sections) {
                layout.addView(TextView(activity).apply { text = (label); textSize = 13f; setTypeface(typeface, Typeface.BOLD); setTextColor(Color.rgb(40, 107, 90)); setPadding(0, 18, 0, 6) })
                layout.addView(TextView(activity).apply { text = value; textSize = 15f; setTextColor(Color.rgb(37, 49, 44)); setTextIsSelectable(true) })
            }
            val offered = decisions()
            for (decision in offered) layout.addView(Button(activity).apply {
                text = (ApprovalReview.labels.getValue(decision))
                isAllCaps = false
                minHeight = (48 * activity.resources.displayMetrics.density).toInt()
                setOnClickListener {
                    if (decision in decisions()) { close(); decide(decision) }
                    else this@Session.invalidate()
                }
            })
            if (invalid == null && snapshot.optString("status") == "pending" && remaining != null && remaining > 0) handler.postDelayed(expiry, remaining + 1)
        }
        private fun showDetails() {
            val fields = mutableListOf(mobileText(R.string.review_run_id, snapshot.optString("runId")), mobileText(R.string.review_version, snapshot.optJSONObject("review")?.optString("reviewVersion") ?: mobileText(R.string.unknown)))
            if (ApprovalReview.decisionSections(snapshot, outcome).isNotEmpty()) outcome?.optJSONObject("actor")?.optString("id")?.let { fields.add(mobileText(R.string.review_device_id, it)) }
            details?.dismiss()
            details = AlertDialog.Builder(activity).setTitle(mobileText(R.string.review_technical)).setMessage(fields.joinToString("\n\n")).setPositiveButton(mobileText(R.string.review_close), null).show()
        }
    }
}
