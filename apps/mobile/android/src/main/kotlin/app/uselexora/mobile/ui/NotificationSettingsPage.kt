package app.uselexora.mobile.ui

import android.Manifest
import android.app.Activity
import android.app.TimePickerDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.FactCheck
import androidx.compose.material.icons.outlined.Inbox
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import app.uselexora.mobile.R
import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.notifications.MobileNotifier
import app.uselexora.mobile.notifications.NotificationPolicy
import app.uselexora.mobile.notifications.NotificationSettings
import app.uselexora.mobile.notifications.NotificationSettingsSnapshot
import app.uselexora.mobile.notifications.TaskNotificationKind
import app.uselexora.mobile.watch.MobileWatchService

@Composable
internal fun NotificationSettingsPage(close: () -> Unit) {
    val context = LocalContext.current
    val settings = remember { NotificationSettings(context) }
    val notifier = remember { MobileNotifier(context) }
    var snapshot by remember { mutableStateOf(settings.read()) }
    var failedMessage by remember { mutableStateOf("") }
    val allowed = NotificationManagerCompat.from(context).areNotificationsEnabled()
    fun update(value: NotificationSettingsSnapshot) {
        snapshot = value
    }

    BackHandler { close() }
    Surface(Modifier.fillMaxSize().testTag("notification-settings"), color = MaterialTheme.colorScheme.background) {
        Column {
            SettingsHeader(mobileText(R.string.settings_notifications_title), mobileText(R.string.label_close_settings), close)
            Column(
                Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(24.dp),
            ) {
                SettingsSection(mobileText(R.string.settings_notifications_section_connection)) {
                    SettingsSwitchRow(
                        mobileText(R.string.settings_notifications_watch),
                        mobileText(R.string.settings_notifications_watch_description),
                        Icons.Outlined.Dns,
                        checked = snapshot.watchEnabled,
                        tag = "notification-watch",
                        divider = false,
                    ) { enabled ->
                        if (enabled) requestNotifications(context)
                        settings.setWatchEnabled(enabled)
                        if (!enabled) MobileWatchService.suspendForUi(context)
                        update(settings.read())
                    }
                    if (!allowed) Text(
                        mobileText(R.string.notification_permission_required),
                        Modifier.padding(start = 16.dp, end = 16.dp, bottom = 12.dp),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                SettingsSection(mobileText(R.string.settings_notifications_section_events)) {
                    SettingsSwitchRow(mobileText(R.string.settings_notifications_approvals),
                        mobileText(R.string.settings_notifications_approvals_description), Icons.Outlined.FactCheck,
                        snapshot.approvals, snapshot.watchEnabled, "notification-approvals") {
                        settings.setApprovals(it)
                        if (!it) notifier.clearKinds(setOf(TaskNotificationKind.Approval))
                        update(settings.read())
                    }
                    SettingsSwitchRow(mobileText(R.string.settings_notifications_questions),
                        mobileText(R.string.settings_notifications_questions_description), Icons.Outlined.Inbox,
                        snapshot.questions, snapshot.watchEnabled, "notification-questions") {
                        settings.setQuestions(it)
                        if (!it) notifier.clearKinds(setOf(TaskNotificationKind.Question))
                        update(settings.read())
                    }
                    SettingsSwitchRow(mobileText(R.string.settings_notifications_completed),
                        mobileText(R.string.settings_notifications_completed_description), Icons.Outlined.CheckCircle,
                        snapshot.completed, snapshot.watchEnabled, "notification-completed") {
                        settings.setCompleted(it)
                        if (!it) clearResults(settings, notifier)
                        update(settings.read())
                    }
                    SettingsSwitchRow(mobileText(R.string.settings_notifications_failed),
                        mobileText(R.string.settings_notifications_failed_description), Icons.Outlined.WarningAmber,
                        snapshot.failed, snapshot.watchEnabled, "notification-failed", divider = false) {
                        settings.setFailed(it)
                        if (!it) clearResults(settings, notifier)
                        update(settings.read())
                    }
                }
                SettingsSection(mobileText(R.string.settings_notifications_section_quiet)) {
                    SettingsSwitchRow(mobileText(R.string.settings_notifications_quiet),
                        mobileText(R.string.settings_notifications_quiet_description), Icons.Outlined.Schedule,
                        snapshot.quietHoursEnabled, snapshot.watchEnabled, "notification-quiet") {
                        settings.setQuietHoursEnabled(it); update(settings.read())
                    }
                    SettingsRow(mobileText(R.string.settings_notifications_quiet_start), Icons.Outlined.Schedule,
                        kind = SettingsRowKind.Selection, enabled = snapshot.watchEnabled && snapshot.quietHoursEnabled,
                        tag = "notification-quiet-start", value = snapshot.quietStart) {
                        pickTime(context, snapshot.quietStart) { settings.setQuietStart(it); update(settings.read()) }
                    }
                    SettingsRow(mobileText(R.string.settings_notifications_quiet_end), Icons.Outlined.Schedule,
                        kind = SettingsRowKind.Selection, enabled = snapshot.watchEnabled && snapshot.quietHoursEnabled,
                        tag = "notification-quiet-end", divider = false, value = snapshot.quietEnd) {
                        pickTime(context, snapshot.quietEnd) { settings.setQuietEnd(it); update(settings.read()) }
                    }
                }
                SettingsSection(mobileText(R.string.settings_notifications_section_content)) {
                    SettingsSwitchRow(mobileText(R.string.settings_notifications_show_title),
                        mobileText(R.string.settings_notifications_show_title_description), Icons.Outlined.Visibility,
                        snapshot.showTitle, snapshot.watchEnabled, "notification-show-title") {
                        settings.setShowTitle(it); update(settings.read())
                    }
                    SettingsSwitchRow(mobileText(R.string.settings_notifications_show_preview),
                        mobileText(R.string.settings_notifications_show_preview_description), Icons.Outlined.Visibility,
                        snapshot.showPreview, snapshot.watchEnabled, "notification-show-preview") {
                        settings.setShowPreview(it); update(settings.read())
                    }
                    SettingsRow(mobileText(R.string.settings_notifications_sound), Icons.Outlined.Settings,
                        mobileText(R.string.settings_notifications_sound_description), tag = "notification-sound", divider = false) {
                        failedMessage = if (openChannelSettings(context)) "" else mobileText(R.string.notification_settings_open_failed)
                    }
                }
                if (failedMessage.isNotEmpty()) Text(failedMessage, Modifier.padding(horizontal = 16.dp),
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

private fun clearResults(settings: NotificationSettings, notifier: MobileNotifier) {
    val current = settings.read()
    if (!current.completed && !current.failed) notifier.clearKinds(setOf(TaskNotificationKind.Result))
}

private fun requestNotifications(context: android.content.Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
    val activity = context as? Activity ?: return
    ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), NOTIFICATION_REQUEST)
}

internal fun openChannelSettings(context: android.content.Context): Boolean {
    val intent = Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
        .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
        .putExtra(Settings.EXTRA_CHANNEL_ID, MobileNotifier.CHANNEL_ACTION)
    if (context !is Activity) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    return runCatching { context.startActivity(intent) }.isSuccess
}

private fun pickTime(context: android.content.Context, current: String, apply: (String) -> Unit) {
    val minutes = NotificationPolicy.minutesOfDay(current) ?: DEFAULT_QUIET_START
    TimePickerDialog(context, { _, hour, minute -> apply("%02d:%02d".format(hour, minute)) }, minutes / 60, minutes % 60, true).show()
}

private const val NOTIFICATION_REQUEST = 0x2A02
private const val DEFAULT_QUIET_START = 22 * 60
