package app.uselexora.mobile.ui

import app.uselexora.mobile.i18n.mobileQuantity
import app.uselexora.mobile.i18n.mobileText
import android.app.Activity
import android.app.AlertDialog
import android.text.TextUtils
import android.text.format.Formatter
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.LinearLayout
import android.widget.TextView
import app.uselexora.mobile.R
import app.uselexora.mobile.preview.PreviewPolicy
import app.uselexora.mobile.session.MobileOperationFailure
import app.uselexora.mobile.storage.LocalFiles

class LocalFilesPanel(private val activity: Activity, private val files: LocalFiles, private val work: (() -> Unit) -> Unit,
    private val ui: (() -> Unit) -> Unit, private val open: (LocalFiles.Entry, Int) -> Unit) {
    fun show(partition: String): Unit = work {
        val entries = files.list()
        val temporary = files.temporary()
        val capacity = files.capacity()
        val rows = buildList<Pair<String, LocalFiles.Entry?>> {
            listOf(true, false).forEach { current ->
                val group = entries.filter { (it.record.getString("partition") == partition) == current }
                if (group.isNotEmpty()) {
                    add(mobileText(if (current) R.string.mobile_current_connection else R.string.mobile_other_connection) to null)
                    group.forEach { add(it.name to it) }
                }
            }
        }
        ui {
            val colors = activity.obtainStyledAttributes(R.styleable.LocalFilePalette)
            val primary = colors.getColorStateList(R.styleable.LocalFilePalette_android_textColorPrimary)
            val secondary = colors.getColorStateList(R.styleable.LocalFilePalette_android_textColorSecondary)
            colors.recycle()
            val dialog = AlertDialog.Builder(activity).setTitle(mobileText(R.string.mobile_phone_files_256_mib, Formatter.formatShortFileSize(activity, capacity.used))).setNegativeButton(mobileText(R.string.review_close), null)
            if (entries.isEmpty()) dialog.setMessage(mobileText(R.string.mobile_no_downloaded_files_or_upload_copies_inputs_and_send))
            else dialog.setAdapter(object : ArrayAdapter<Pair<String, LocalFiles.Entry?>>(activity, android.R.layout.simple_list_item_2, rows) {
                override fun areAllItemsEnabled() = false
                override fun isEnabled(position: Int) = rows[position].second != null
                override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
                    val row = convertView as? LinearLayout ?: LinearLayout(activity).apply {
                        orientation = LinearLayout.VERTICAL
                        val padding = (16 * resources.displayMetrics.density).toInt()
                        setPadding(padding, padding, padding, padding)
                        addView(TextView(activity).apply { textSize = 16f; primary?.let(::setTextColor); maxLines = 2; ellipsize = TextUtils.TruncateAt.END })
                        addView(TextView(activity).apply { textSize = 13f; secondary?.let(::setTextColor); setPadding(0, padding / 3, 0, 0) })
                    }
                    val entry = rows[position].second
                    (row.getChildAt(0) as TextView).apply {
                        text = rows[position].first
                        setTypeface(null, if (entry == null) android.graphics.Typeface.BOLD else android.graphics.Typeface.NORMAL)
                        textSize = if (entry == null) 14f else 16f
                    }
                    (row.getChildAt(1) as TextView).visibility = if (entry == null) View.GONE else View.VISIBLE
                    if (entry != null) (row.getChildAt(1) as TextView).text = "${Formatter.formatShortFileSize(activity, entry.file.length())} · ${if (entry.previewOnly && entry.complete) mobileText(R.string.preview_cache_label) else if (entry.download) if (entry.complete) mobileText(R.string.mobile_downloaded) else mobileText(R.string.mobile_download_incomplete) else if (entry.removable) mobileText(R.string.mobile_upload_finished) else mobileText(R.string.mobile_upload_awaiting_confirmation)} · ${if (entry.record.getString("partition") == partition) mobileText(R.string.mobile_current_connection) else mobileText(R.string.mobile_other_connection)}"
                    return row
                }
            }) { _, index -> rows[index].second?.let { actions(it, partition) } }
            if (temporary.isNotEmpty()) dialog.setNeutralButton(mobileText(R.string.mobile_clean_up_temporary_files)) { _, _ ->
                AlertDialog.Builder(activity).setTitle(mobileQuantity(R.plurals.mobile_remove_leftover_temporary_files, temporary.size))
                    .setMessage(mobileText(R.string.mobile_total_these_files_are_over_24_hours_old_and, Formatter.formatShortFileSize(activity, temporary.sumOf { it.bytes })))
                    .setNegativeButton(mobileText(R.string.label_cancel), null).setPositiveButton(mobileText(R.string.mobile_clean_up)) { _, _ -> work {
                        val removed = files.removeTemporary(temporary)
                        ui { AlertDialog.Builder(activity).setMessage(mobileQuantity(R.plurals.mobile_removed_files_files_that_changed_during_cleanup_were_kept, removed)).setPositiveButton(mobileText(R.string.mobile_view_files)) { _, _ -> show(partition) }.show() }
                    } }.show()
            }
            dialog.show()
        }
    }
    private fun actions(entry: LocalFiles.Entry, partition: String) {
        val actions = mutableListOf<Int>()
        if (entry.complete) {
            if (PreviewPolicy.kind(entry.name, entry.mime) != null) actions.add(R.string.preview_action)
            actions.addAll(listOf(R.string.save_to_files, R.string.share_file_title))
        }
        if (entry.removable) actions.add(R.string.mobile_remove_phone_copy)
        val dialog = AlertDialog.Builder(activity).setTitle(entry.name).setNegativeButton(mobileText(R.string.review_close), null)
        if (actions.isEmpty()) dialog.setMessage(mobileText(R.string.mobile_the_upload_or_command_is_still_unconfirmed_so_this))
        else dialog.setItems(actions.map { mobileText(it) }.toTypedArray()) { _, index ->
            if (entry.previewOnly && actions[index] !in setOf(R.string.preview_action, R.string.mobile_remove_phone_copy)) work {
                files.retain(entry.file)
                ui { open(entry, actions[index]) }
            } else if (actions[index] != R.string.mobile_remove_phone_copy) open(entry, actions[index])
            else AlertDialog.Builder(activity).setTitle(mobileText(R.string.mobile_remove_this_phone_copy)).setMessage(mobileText(R.string.mobile_only_the_app_s_copy_of_will_be_removed, entry.name))
                .setNegativeButton(mobileText(R.string.label_cancel), null).setPositiveButton(mobileText(R.string.mobile_clean_up)) { _, _ -> work {
                    try { files.remove(entry.record); show(partition) }
                    catch (error: Exception) { ui {
                        AlertDialog.Builder(activity).setTitle(entry.name)
                            .setMessage(MobileFailurePresentation.message(MobileOperationFailure.from(error)))
                            .setNegativeButton(mobileText(R.string.review_close), null)
                            .setPositiveButton(mobileText(R.string.mobile_view_files)) { _, _ -> show(partition) }.show()
                    } }
                } }.show()
        }
        dialog.show()
    }
}
