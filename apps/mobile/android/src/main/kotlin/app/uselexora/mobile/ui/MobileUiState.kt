package app.uselexora.mobile.ui

import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.R
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import org.json.JSONObject

enum class MobileScreen { Workbench, Spaces, Tasks, Devices, Conversation }

enum class MobileTaskFilter { All, Approvals, Questions, Unread, Marked }

enum class MobileAction {
    NewTask, OpenTask, OpenTaskQuestions, OpenRunningTask, OpenTaskResult, ShowTasks, ShowPending, ShowDevices,
    ShowWorkbench, ShowSpaces, OpenSpace, ChooseSpaceFilter, ShowTaskFilter, Back, ReviewTaskApproval,
    ScanDevice, SelectDevice, ManageDevice,
    Approvals, Outbox, Recovery, Files, ManageFiles, AttachFile, TakePhoto, OpenResource, ResourceActions, MoreFiles,
    ChooseModel, ChooseReasoning, ToggleFast, ApplyModel, ChooseExecution, ApplyExecution, ChooseSpace, Send,
    MoreHistory, Refresh, Reconnect, TaskControls, TaskQueue, TaskBranches, SelectBranch,
    QueueInput, OpenOnDesktop, ReadState, Disconnect, MessageActions, DismissNotice,
    CopyMessage, EditMessage, ContinueMessage, RegenerateMessage, ShowMessageRun, OpenMessageDetail,
    StopRun, ReviewApproval, AnswerQuestion, OpenAttachment, RemoveAttachment,
}

data class MobileDeviceItem(
    val id: String,
    val label: String,
    val address: String,
    val selected: Boolean = false,
    val connected: Boolean = false,
    val lastConnectedLabel: String? = null,
    val platform: String? = null,
)

data class MobileAttachmentItem(
    val id: String,
    val name: String,
    val mimeType: String,
    val stateLabel: String,
    val canRemove: Boolean,
)

data class MobileMessageMenu(
    val message: JSONObject,
    val text: String,
    val canCopy: Boolean,
    val canEdit: Boolean,
    val needsDetail: Boolean,
    val run: JSONObject? = null,
    val canRegenerate: Boolean = false,
    val loading: Boolean = false,
)

data class MobileTaskFiles(
    val id: String,
    val conversationId: String,
    val items: List<JSONObject> = emptyList(),
    val loading: Boolean = true,
    val error: String? = null,
    val nextCursor: String? = null,
)

class MobileUiState {
    var incomingMaterial by mutableStateOf<IncomingMaterial?>(null)
    var importingMaterial by mutableStateOf(false)
    var materialError by mutableStateOf("")
    var taskFiles by mutableStateOf<MobileTaskFiles?>(null)
    var messageMenu by mutableStateOf<MobileMessageMenu?>(null)
    var screen by mutableStateOf(MobileScreen.Workbench)
    var notice by mutableStateOf("")
    var connectionLabel by mutableStateOf(mobileText(R.string.connection_not_connected))
    var devicePlatform by mutableStateOf<String?>(null)
    var connectionPhase by mutableStateOf(app.uselexora.mobile.session.MobileConnectionPhase.Idle)
    var deviceLabel by mutableStateOf(mobileText(R.string.label_choose_service))
    var connected by mutableStateOf(false)
    var tasks by mutableStateOf<List<JSONObject>>(emptyList())
    var tasksLoaded by mutableStateOf(false)
    var taskSyncFailed by mutableStateOf(false)
    var taskFilter by mutableStateOf(MobileTaskFilter.All)
    var markedTaskIds by mutableStateOf<Set<String>>(emptySet())
    var marksLoaded by mutableStateOf(false)
    var marksFailed by mutableStateOf(false)
    var spaces by mutableStateOf<List<JSONObject>>(emptyList())
    var selectedSpaceId by mutableStateOf<String?>(null)
    var selectedSpaceLabel by mutableStateOf(mobileText(R.string.label_all_spaces))
    var selectedTaskSpaceLabel by mutableStateOf(mobileText(R.string.label_no_space))
    var readingCached by mutableStateOf(false)
    var messages by mutableStateOf<List<JSONObject>>(emptyList())
    var runs by mutableStateOf<List<JSONObject>>(emptyList())
    var queueItems by mutableStateOf<List<JSONObject>>(emptyList())
    var approvalItems by mutableStateOf<List<JSONObject>>(emptyList())
    var questions by mutableStateOf<List<JSONObject>>(emptyList())
    var questionsSupported by mutableStateOf(false)
    var branches by mutableStateOf<List<JSONObject>>(emptyList())
    var branchesLoading by mutableStateOf(false)
    var branchesFailed by mutableStateOf(false)
    var attachments by mutableStateOf<List<MobileAttachmentItem>>(emptyList())
    var resultRunId by mutableStateOf<String?>(null)
    var stoppingRunId by mutableStateOf<String?>(null)
    var selectedTask by mutableStateOf<JSONObject?>(null)
    var viewBranchId by mutableStateOf<String?>(null)
    var topic by mutableStateOf("taskIndex")
    var devices by mutableStateOf<List<MobileDeviceItem>>(emptyList())
    var hasInput by mutableStateOf(false)
    var modelPickerShowList by mutableStateOf(false)
    var modelPickerOpen by mutableStateOf(false)
    var modelsLoading by mutableStateOf(false)
    var modelsError by mutableStateOf("")
    var models by mutableStateOf<List<JSONObject>>(emptyList())
    var modelSelection by mutableStateOf<JSONObject?>(null)
    var executionSelection by mutableStateOf(JSONObject())
    var executionPickerOpen by mutableStateOf(false)
    var modelLabel by mutableStateOf(mobileText(R.string.label_choose_model))
    var executionLabel by mutableStateOf(mobileText(R.string.label_smart_approval))
    var spaceLabel by mutableStateOf(mobileText(R.string.mobile_choose_space))
    var inputEnabled by mutableStateOf(true)
    var sendEnabled by mutableStateOf(false)
    var configEnabled by mutableStateOf(true)
    var executionEnabled by mutableStateOf(true)
    var spaceVisible by mutableStateOf(true)
    var spaceEnabled by mutableStateOf(true)
    var inputFeedback by mutableStateOf("")
    var attachmentCount by mutableStateOf(0)
    var outboxCount by mutableStateOf<Int?>(null)
}
