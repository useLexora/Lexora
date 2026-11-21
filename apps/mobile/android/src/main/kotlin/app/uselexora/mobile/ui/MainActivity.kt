package app.uselexora.mobile.ui

import app.uselexora.mobile.i18n.MobileStrings
import app.uselexora.mobile.i18n.mobileText
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import android.Manifest
import android.content.ClipData
import android.content.pm.PackageManager
import android.provider.MediaStore
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Color
import android.content.res.ColorStateList
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.net.ConnectivityManager
import android.text.Editable
import android.text.TextWatcher
import android.text.Spanned
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.*
import app.uselexora.mobile.R
import app.uselexora.mobile.BuildConfig
import app.uselexora.mobile.preview.PreviewPolicy
import app.uselexora.mobile.preview.PreviewActivity
import androidx.core.content.FileProvider
import app.uselexora.mobile.network.ApprovalDocuments
import app.uselexora.mobile.network.MobileFiles
import app.uselexora.mobile.storage.TransferStore
import app.uselexora.mobile.network.MobileConnection
import app.uselexora.mobile.session.MobileConnectionSession
import app.uselexora.mobile.session.MobileComposerSession
import app.uselexora.mobile.session.MobileOperations
import app.uselexora.mobile.session.MobileOperationOwner
import app.uselexora.mobile.session.MobileOperationFailure
import app.uselexora.mobile.session.MobileTaskReadModel
import app.uselexora.mobile.network.ProductClient
import app.uselexora.mobile.protocol.ExecutionMode
import app.uselexora.mobile.protocol.DraftContext
import app.uselexora.mobile.protocol.ExecutionSettings
import app.uselexora.mobile.protocol.NewTaskDefaults
import app.uselexora.mobile.protocol.MobileMessageDetail
import app.uselexora.mobile.storage.LocalDraft
import app.uselexora.mobile.protocol.CommandOutbox
import app.uselexora.mobile.protocol.CommandReceipt
import app.uselexora.mobile.protocol.ConversationTarget
import app.uselexora.mobile.protocol.TaskModelLane
import app.uselexora.mobile.protocol.TaskModelTarget
import app.uselexora.mobile.protocol.TaskModelEdit
import app.uselexora.mobile.protocol.HistorySource
import app.uselexora.mobile.protocol.MobileContentAdapter
import app.uselexora.mobile.protocol.MobileMessagePresentation
import app.uselexora.mobile.protocol.ProductIdentity
import app.uselexora.mobile.protocol.ProtocolFailure
import app.uselexora.mobile.protocol.ProtocolSchemas
import app.uselexora.mobile.storage.PhotoStore
import app.uselexora.mobile.storage.DocumentExport
import app.uselexora.mobile.storage.LocalFiles
import app.uselexora.mobile.storage.ComposerEdit
import app.uselexora.mobile.storage.ComposerMemory
import app.uselexora.mobile.storage.MaterialDrafts
import app.uselexora.mobile.storage.LocalStore
import app.uselexora.mobile.storage.ReadCache
import com.google.zxing.integration.android.IntentIntegrator
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

class MainActivity : ComponentActivity() {
    private val ui = MobileUiState()
    private val screenHistory = ArrayDeque<MobileScreen>()
    private var details by androidx.compose.runtime.mutableStateOf<Map<String, MobileMessageDetail>>(emptyMap())
    private val navigationStore by lazy { getSharedPreferences("mobile-navigation", MODE_PRIVATE) }
    private lateinit var composer: EditText
    private lateinit var store: LocalStore
    private lateinit var schemas: ProtocolSchemas
    private lateinit var connection: MobileConnection
    private lateinit var transfers: TransferStore
    private lateinit var files: MobileFiles
    private val taskFileCopies by lazy { TaskFileCopies(this, transfers, store) }
    private val downloadingResources = mutableSetOf<String>()
    private lateinit var operations: TaskOperations
    private lateinit var recovery: DraftRecoveryPanel
    private lateinit var questions: MobileQuestions
    private var messageItems = listOf<JSONObject>()
    private var liveMessages = listOf<JSONObject>()
    private var historicalMessages = listOf<JSONObject>()
    private var readyContext: String? = null
    private var historyRequest = 0L
    private var discoveryOwner = ""
    private var executionPickerOwner: String? = null
    private var executionPickerScope: String? = null
    private val discoveryController by lazy { TaskDiscoveryController(ui, { client }, { "$partition:$connectionGeneration:${ui.screen}:${ui.selectedSpaceId}:${ui.taskFilter}:${selectedTask?.optString("id")}:${ui.discovery.archived}" }, ::work, ::onUi) }
    private fun liveContext() = "$partition:$connectionGeneration:$activeTopic"
    private val network = Executors.newSingleThreadExecutor()
    private lateinit var input: MobileComposerSession
    private var saveFeedbackClear: Runnable? = null
    private var resultReadKey: String? = null
    private val readResults = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
    private val suppressedReadResults = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
    private lateinit var session: MobileConnectionSession
    private val client get() = session.client
    private val subscription get() = session.subscription
    private val connectionGeneration get() = session.generation
    private val foreground get() = session.foreground
    private lateinit var readModel: MobileTaskReadModel
    private var projectedTaskSource: JSONObject? = null
    private var sortedTaskSource: List<JSONObject>? = null
    private var displayedMessages: List<JSONObject>? = null
    private var displayedTask: JSONObject? = null
    private var conversationTarget: ConversationTarget? = null
    private var activeTopic: String
        get() = conversationTarget?.topic ?: "taskIndex"
        set(value) { conversationTarget = ConversationTarget.fromTopic(value) }
    private var partition: String
        get() = input.scope.partition
        set(value) { input.select(value, input.scope.target) }
    private var scope: String
        get() = input.scope.target
        set(value) { input.select(input.scope.partition, value) }
    private var writingView = false
    private var selectedTask: JSONObject? = null
    private var model: JSONObject? = null
    private var inheritedModel: JSONObject? = null
    private var modelContextKey = ""
    private var modelContextRequest = 0L
    private var savedExecution: JSONObject? = null
    private var openingNewTaskDraft = false
    private class NewTaskEntry(val owner: MobileOperationOwner, var readingDefaults: Boolean,
        var defaults: NewTaskDefaults? = null, var failed: Boolean = false)
    private var newTaskEntry: NewTaskEntry? = null
    private val currentEntry get() = newTaskEntry?.takeIf { isCurrent(it.owner) }
    private val executionConfig get() = savedExecution ?: currentEntry?.defaults?.execution
    private var changingExecution = false
    private var spaceId: String? = null
    private var spaceName: String? = null
    private var demo = false
    private var readerBenchmark: MobileReaderBenchmark? = null
    @Volatile private var destroyed = false
    private var disconnecting = false
    private val streamHandler = Handler(Looper.getMainLooper())
    private var taskItems: List<JSONObject>
        get() = readModel.tasks
        set(value) { readModel.replaceTasks(value) }
    private var navigation = 0L
    private var pendingFileTarget: JSONObject? = null
    private var pendingCapturePath: String? = null
    private var pendingSave: JSONObject? = null
    private var pendingPreview: JSONObject? = null
    private val incomingMaterials = ArrayDeque<IncomingMaterial>()

    override fun attachBaseContext(base: android.content.Context) {
        super.attachBaseContext(MobileStrings.localizedContext(base))
    }
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        MobileAppearance.load(this)
        store = LocalStore(this)
        schemas = ProtocolSchemas(JSONObject(assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
        connection = MobileConnection(this, schemas, BuildConfig.VERSION_NAME)
        transfers = TransferStore(this)
        input = MobileComposerSession(store, ComposerMemory(store, transfers), disk, streamHandler, ::onUi)
        files = MobileFiles(this, transfers, store, connection)
        pendingFileTarget = state?.getString("fileTarget")?.let { JSONObject(it) }
        pendingCapturePath = state?.getString("capturePath")
        pendingSave = state?.getString("pendingSave")?.let { JSONObject(it) }
        pendingPreview = state?.getString("pendingPreview")?.let { JSONObject(it) }
        state?.getString("incomingMaterials")?.let { raw -> val values = JSONArray(raw); for (index in 0 until values.length()) incomingMaterials.addLast(IncomingMaterial.restore(values.getJSONObject(index))) }
        operations = TaskOperations(this, store, ::connected, ApprovalDocuments(connection), schemas, ::work, ::onUi) { receipt ->
            if (receipt == null) subscription?.subscribe(activeTopic) ?: selectedTask?.let { showTask(it) } ?: refreshTasks()
            else {
                val topic = activeTopic
                val current = client
                val owner = partition
                if (current != null) work {
                    val target = receipt.getJSONObject("target")
                    val task = current.call("conversations.get", JSONObject().put("conversationId", target.getString("conversationId")))
                    val destination = ConversationTarget.fromTarget(target)
                    onUi { if (activeTopic == topic && partition == owner && client === current) showTask(task, target = destination) }
                }
            }
        }
        operations.onReadStateChanged = { state, read ->
            val key = "${partition}:${state.getString("conversationId")}:${state.optString("resultRunId")}"
            if (!read) suppressedReadResults.add(key) else suppressedReadResults.remove(key)
        }
        questions = MobileQuestions(this, store, schemas, ::work, ::onUi, { ui.questions = it }, ::showNotice)
        readModel = MobileTaskReadModel(ReadCache(File(cacheDir, "product-read-v1")), schemas, streamHandler,
            context = { MobileTaskReadModel.Context(partition, activeTopic, client, connectionGeneration) }, work = ::work, onUi = ::onUi,
            catalogChanged = { ui.models = it.items; ui.modelProviders = it.providers; ui.modelsLoading = it.loading; ui.modelsError = it.error },
            marksChanged = { ui.markedTaskIds = it.ids; ui.marksLoaded = it.loaded; ui.marksFailed = it.failed },
            cachedTasks = { ui.tasksLoaded = true },
            cachedConversation = { messages, branches ->
                branches?.let { if (ui.branches.isEmpty()) ui.branches = it }
                if (messages != null && !ui.historyPinned && readyContext != liveContext()) { messageItems = visibleMessages(messages); ui.readingCached = true }
            })
        session = MobileConnectionSession(connection, schemas, getSystemService(ConnectivityManager::class.java), streamHandler,
            enabled = { !demo && !disconnecting }, topic = { activeTopic }, work = ::work, onUi = ::onUi,
            released = { operations.closeReview(); questions.close() },
            connected = { authenticated, identity ->
                ui.connectionPhase = app.uselexora.mobile.session.MobileConnectionPhase.Idle
                if (partition != identity.partition) restoreNavigation(identity.partition)
                partition = identity.partition; restoreInput(); restoreCachedCatalogs(); refreshDevices(); refreshSpaces(); refreshPendingOperations(); ui.connectionLabel = mobileText(R.string.connection_loading_tasks)
                if (ui.notice == MobileFailurePresentation.NETWORK_UNAVAILABLE_NOTICE || ui.notice == mobileText(R.string.error_not_connected)) ui.notice = ""
                subscription?.subscribe(activeTopic); bindQuestions(); if (selectedTask != null) loadBranches()
                checkInputReceipts(authenticated)
                if (activeTopic != "taskIndex") refreshTaskMarks()
                if (incomingMaterials.isNotEmpty() && !ui.importingMaterial) ui.incomingMaterial = incomingMaterials.first()
                syncUi()
            },
            status = { label, phase ->
                ui.connectionLabel = label; ui.connectionPhase = phase
                if (ui.pairingPhase == "syncing") ui.pairingError = if (phase == app.uselexora.mobile.session.MobileConnectionPhase.Unavailable) label else ""
                syncUi()
            },
            failureMessage = { MobileFailurePresentation.message(MobileOperationFailure.from(it)) },
            synchronization = { state ->
                ui.synchronization = state
                if (state == "SYNCHRONIZED") ui.connectionLabel = mobileText(R.string.connection_connected)
                if (state != "SYNCHRONIZED") { readyContext = null; ui.conversationReady = false }
                if (state == "SYNCING") ui.syncFailure = ""
                if (activeTopic == "taskIndex") ui.taskSyncFailed = state == "UNSYNCHRONIZED"
                if (state == "UNSYNCHRONIZED" && ui.syncFailure.isBlank()) ui.syncFailure = mobileText(if (activeTopic == "taskIndex") R.string.mobile_task_update_failed else R.string.mobile_sync_failed_input)
                if (state == "SYNCHRONIZED" && ui.pairingPhase == "syncing") ui.pairingPhase = "ready"
                syncUi()
            },
            projection = { topic, items -> readModel.committed(topic, items); readyContext = liveContext(); ui.readingCached = false; ui.syncFailure = ""; renderProjection(topic, items); syncUi() },
            recoverable = { MobileOperationFailure.from(it).code == "SERVICE_UNREACHABLE" },
            synchronizationFailure = { error -> ui.syncFailure = MobileFailurePresentation.message(MobileOperationFailure.from(error)); readyContext = null; ui.conversationReady = false })
        demo = BuildConfig.PROBE_ENABLED && intent.getBooleanExtra("fixture", false)
        session.reconnectAllowed = state?.getBoolean("reconnectAllowed", true) ?: true
        val savedIdentity = runCatching { if (demo) null else connection.description() }
        partition = if (demo) "fixture:service:profile:generation:device" else savedIdentity.getOrNull()?.let { ProductIdentity.partition(it) } ?: "unpaired-local"
        val savedState = state?.takeIf { it.getString("partition") == partition }
        scope = savedState?.getString("scope") ?: "global"
        selectedTask = savedState?.getString("task")?.let { JSONObject(it) }
        conversationTarget = runCatching { ConversationTarget.fromTopic(savedState?.getString("topic") ?: "taskIndex") }.getOrNull()
        recovery = DraftRecoveryPanel(this, store, { partition }, ::localWork, ::onUi, ::resumeDraft,
            targetLabel = { draft ->
                if (draft.partition != partition) null
                else runCatching { DraftContext.conversation(draft.scope) }.getOrNull()?.let { recoveryTargetLabel(draft.partition, it.conversationId) }
            },
            attachmentLookup = ::recoveryAttachmentLookup)
        if (savedState == null && !demo && partition != "unpaired-local") { restoreNavigation(partition); activeTopic = "taskIndex" }
        savedState?.getStringArrayList("screenHistory")?.forEach { value -> MobileScreen.entries.firstOrNull { it.name == value }?.let(screenHistory::addLast) }
        buildLayout()
        if (savedState != null) {
            ui.selectedSpaceId = savedState.getString("selectedSpaceId")
            ui.selectedSpaceLabel = when (ui.selectedSpaceId) { null -> mobileText(R.string.label_all_spaces); "" -> mobileText(R.string.label_no_space); else -> savedState.getString("selectedSpaceLabel").orEmpty() }
            ui.taskFilter = MobileTaskFilter.entries.firstOrNull { it.name == savedState.getString("taskFilter") } ?: MobileTaskFilter.All
        }
        savedState?.getString("screen")?.let { value -> MobileScreen.entries.firstOrNull { it.name == value }?.let { ui.screen = it } }
        if (savedIdentity.isFailure) ui.notice = mobileText(R.string.mobile_unable_to_read_the_phone_s_connection_identity_your)
        restoreInput(); restoreCachedCatalogs(); refreshPendingOperations()
        if (demo) {
            loadFixture()
            val seconds = intent.getIntExtra("readerBenchmarkSeconds", 0)
            if (seconds in 10..180) {
                showTask(taskItems.first())
                readerBenchmark = MobileReaderBenchmark(this, seconds) { messages, runs -> messageItems = messages; ui.runs = runs; syncUi() }.also { it.start() }
            }
        } else if (selectedTask != null && activeTopic.startsWith("conversation:")) restoreCachedConversation()
        if (state == null) receiveMaterial(intent)
        else ui.incomingMaterial = incomingMaterials.firstOrNull()
    }

    private fun buildLayout() {
        composer = EditText(this).apply {
            id = INPUT_ID
            isSaveEnabled = false
            hint = mobileText(R.string.label_what_would_you_like_lexora_to_do)
            textSize = 16f; gravity = Gravity.TOP
            minLines = 1; maxLines = 6; setPadding(0, dp(10), 0, dp(10))
            background = null
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE or android.text.InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            imeOptions = android.view.inputmethod.EditorInfo.IME_ACTION_NONE or android.view.inputmethod.EditorInfo.IME_FLAG_NO_EXTRACT_UI or android.view.inputmethod.EditorInfo.IME_FLAG_NO_FULLSCREEN
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
                override fun afterTextChanged(s: Editable?) { if (!writingView) persistInput(s ?: "", keepSettings = false); syncUi() }
            })
        }
        ui.connectionLabel = if (demo) mobileText(R.string.mobile_local_demo) else mobileText(R.string.mobile_not_connected)
        ui.screen = MobileScreen.Workbench
        refreshDevices()
        setContent {
            LexoraTheme {
                val connectedClient = if (ui.connected) client else null
                ui.incomingMaterial?.let { IncomingMaterialPanel(it, ui, ::chooseMaterialDestination, ::dismissMaterial) }
                MobileShell(ui, composer, ::handleAction, ReaderAvatarContext(partition, connectedClient, schemas)) { modifier ->
                    WebMessageTimeline(ui.messages, ui.readerTopic, modifier, details, ui.runs,
                        anchorMessageId = ui.anchorMessageId, anchorRequestId = ui.anchorRequestId,
                        hasLaterMessages = ui.historyPinned, onLatest = ::returnLatest,
                        avatarContext = ReaderAvatarContext(partition, connectedClient, schemas),
                        artifactContext = ui.viewBranchId?.let { branchId -> ReaderArtifactContext(partition, branchId, connectedClient, schemas) { connection, resource ->
                            val owner = connection.identity?.partition ?: throw ProtocolFailure("NOT_CONNECTED")
                            taskFileCopies.find(owner, resource) ?: files.download(connection, resource, previewOnly = true)
                        } }, onResourceActions = ::resourceActions,
                        branches = ui.branches, selectedBranchId = ui.viewBranchId, onBranch = ::selectBranch,
                        onMessageMenu = { message, anchor, contextual -> prepareMessageAction(message, null, anchor, contextual) },
                        transcripts = transcriptRecords, onLoadTranscript = runTranscripts::request,
                        resultRunId = ui.resultRunId, onReadResult = ::readVisibleResult, onMessageAction = ::messageActions, onQuickAction = ::messageQuickAction, onResource = ::openResource, onLoadDetail = ::loadMessageDetail)
                }
            }
        }
        syncUi()
    }

    internal fun handleAction(action: MobileAction, payload: JSONObject?) {
        when (action) {
            MobileAction.SearchTasks -> payload?.let { discoveryController.search(it.optString("query"), it.optBoolean("more")) }
            MobileAction.ToggleArchives -> { ui.discovery.archived = !ui.discovery.archived; ui.discovery.results = emptyList(); if (ui.discovery.archived) discoveryController.archives() }
            MobileAction.LoadArchives -> discoveryController.archives(payload?.optBoolean("more") == true)
            MobileAction.OpenArchivedTask -> payload?.let { openDiscoveryHit(JSONObject().put("kind", "task").put("conversationId", it.getString("id")).put("archived", true)) }
            MobileAction.OpenSearchHit -> payload?.let { openDiscoveryHit(JSONObject(it.toString()).put("archived", ui.discovery.archived)) }
            MobileAction.RestoreArchivedTask -> payload?.let(::restoreArchivedTask)
            MobileAction.ShowMembers -> discoveryController.members()
            MobileAction.AddMember, MobileAction.RemoveMember, MobileAction.SelectBuddy -> payload?.let { changeMember(action, it) }
            MobileAction.ReturnLatest -> returnLatest()
            MobileAction.ExitHistoryInput -> conversationTarget?.let { scope = it.localKey; restoreInput() }
            MobileAction.ClosePairing -> { ui.pairingPhase = null; ui.pairingError = "" }
            MobileAction.NewTask -> newTask()
            MobileAction.OpenTask -> payload?.let(::openTask)
            MobileAction.OpenTaskQuestions -> payload?.let { task -> openTaskAt(task) { it.optInt("pendingQuestionCount") > 0 } }
            MobileAction.OpenRunningTask -> payload?.let { task -> openTaskAt(task) { it.optInt("runningCount") > 0 } }
            MobileAction.OpenTaskResult -> payload?.let { task -> openTaskAt(task) { it.optString("id") == task.optString("resultBranchId") } }
            MobileAction.ShowTasks -> showTaskFilter(MobileTaskFilter.All)
            MobileAction.ShowTaskFilter -> MobileTaskFilter.entries.firstOrNull { it.name == payload?.optString("filter") }?.let(::showTaskFilter)
            MobileAction.ShowWorkbench -> { showRoot(MobileScreen.Workbench) }
            MobileAction.ShowSpaces -> { showRoot(MobileScreen.Spaces) }
            MobileAction.OpenSpace -> { ui.discovery.archived = false; ui.taskFilter = MobileTaskFilter.All; selectSpaceFilter(payload); navigate(MobileScreen.Tasks); refreshTasks() }
            MobileAction.ChooseSpaceFilter -> chooseSpaceFilter()
            MobileAction.Back -> goBack()
            MobileAction.ReviewTaskApproval -> payload?.optString("id")?.let { operations.approvalsForTask(it) }
            MobileAction.ShowPending -> showRoot(MobileScreen.Workbench)
            MobileAction.ShowDevices -> { navigate(MobileScreen.Devices); refreshDevices() }
            MobileAction.ScanDevice -> IntentIntegrator(this).setCaptureActivity(PairingCaptureActivity::class.java).setDesiredBarcodeFormats(IntentIntegrator.QR_CODE).setPrompt(mobileText(R.string.mobile_scan_the_pairing_qr_code_from_your_lexora_service)).setBeepEnabled(false).initiateScan()
            MobileAction.SelectDevice -> payload?.optString("id")?.let(::switchDevice)
            MobileAction.ManageDevice -> payload?.optString("id")?.let(::manageDevice)
            MobileAction.Approvals -> showApprovals()
            MobileAction.InspectUnplacedInput -> inspectUnplacedInput()
            MobileAction.RecoverDownloads -> showLocalFiles()
            MobileAction.Recovery -> showRecovery()
            MobileAction.Files -> selectedTask?.let { showTaskFiles(it.getString("id")) } ?: showFiles()
            MobileAction.OpenResource -> payload?.let { value ->
                val resource = value.optJSONObject("resource")
                if (resource == null) openResource(value)
                else value.optInt("fileAction").takeIf { it in setOf(R.string.preview_action, R.string.save_to_files, R.string.share_file_title, R.string.open_other_app) }?.let { downloadFile(resource, it) }
            }
            MobileAction.ResourceActions -> payload?.let(::resourceActions)
            MobileAction.MoreFiles -> ui.taskFiles?.let { loadTaskFiles(it) }
            MobileAction.AttachFile -> selectFile()
            MobileAction.TakePhoto -> capturePhoto()
            MobileAction.ChooseModel -> chooseModel()
            MobileAction.ToggleFast -> {
                if (MobileModelControls.supportsFast(ui.modelSelection, ui.models)) ui.modelSelection?.let { selection ->
                    chooseModel(JSONObject(selection.toString()).put("serviceTier", if (selection.optString("serviceTier") == "priority") JSONObject.NULL else "priority"))
                }
            }
            MobileAction.ApplyModel -> payload?.let(::applyModel)
            MobileAction.ApplyExecution -> payload?.let { chooseExecution(it) }
            MobileAction.ChooseExecution -> chooseExecution()
            MobileAction.ChooseSpace -> chooseSpace()
            MobileAction.Send -> send()
            MobileAction.MoreHistory -> moreHistory()
            MobileAction.Refresh -> if (isNewTaskPage()) restoreInput(retryDefaults = true) else {
                refreshSpaces()
                if (ui.screen == MobileScreen.Conversation && selectedTask != null) { refreshConversation(); refreshTaskMarks() }
                else refreshTasks()
            }
            MobileAction.Reconnect -> resumeConnection()
            MobileAction.TaskControls -> conversationTarget?.let(operations::runs)
            MobileAction.TaskQueue -> conversationTarget?.let(operations::queue)
            MobileAction.TaskBranches -> loadBranches()
            MobileAction.SelectBranch -> payload?.let(::selectBranch)
            MobileAction.CheckInputReceipt -> client?.let { checkInputReceipts(it, scope) }
            MobileAction.QueueInput -> if (selectedTask != null && scope.startsWith("conversation:")) send("chat.queue.enqueue")
            MobileAction.OpenOnDesktop -> openOnDesktop()
            MobileAction.ReadState -> selectedTask?.let { operations.readState(JSONObject(it.toString())) }
            MobileAction.Disconnect -> disconnect()
            MobileAction.MessageActions -> payload?.let(::messageActions)
            MobileAction.CopyMessage, MobileAction.EditMessage, MobileAction.ContinueMessage, MobileAction.RegenerateMessage, MobileAction.ShowMessageRun, MobileAction.OpenMessageDetail -> performMessageAction(action)
            MobileAction.DismissNotice -> ui.notice = ""
            MobileAction.StopRun -> payload?.let { run -> operations.stopRun(run) { id ->
                if (ui.runs.any { it.optString("id") == id && it.optString("status") in setOf("queued", "running") }) ui.stoppingRunId = id
            } }
            MobileAction.ReviewApproval -> payload?.let(operations::review)
            MobileAction.AnswerQuestion -> payload?.let(questions::show)
            MobileAction.OpenAttachment -> payload?.optString("id")?.let(::openAttachment)
            MobileAction.RemoveAttachment -> payload?.optString("id")?.let(::removeAttachment)
        }
        syncUi()
    }
    private var transcriptRecords by androidx.compose.runtime.mutableStateOf<Map<String, JSONObject>>(emptyMap())
    private val runTranscripts = MobileRunTranscripts { transcriptRecords = it }

    private fun syncUi() {
        ui.connected = demo || client?.isConnected == true
        if (discoveryOwner != partition) { discoveryOwner = partition; ui.discovery = TaskDiscoveryState(); ui.membersOpen = false; ui.members = null }
        ui.discovery.supported = client?.supports("conversations.search") == true
        ui.discovery.archiveSupported = client?.supports("conversations.listArchived") == true
        ui.membersSupported = client?.supports("conversations.listMembers") == true && client?.supports("buddies.list") == true
        ui.memberActions = mapOf(MobileAction.AddMember to "conversations.addMember", MobileAction.RemoveMember to "conversations.removeMember", MobileAction.SelectBuddy to "conversations.setBuddy").filterValues { client?.supports(it) == true }.keys
        ui.conversationReady = demo || (ui.connected && !ui.readingCached && (conversationTarget == null || (session.isSynchronized && readyContext == liveContext())))
        ui.historyInput = scope.startsWith("message-edit:") || scope.startsWith("message-followup:")
        ui.questionsSupported = client?.supports("questions.list") == true
        if (sortedTaskSource !== taskItems) { sortedTaskSource = taskItems; ui.tasks = taskItems.sortedByDescending { it.optString("updatedAt") } }
        if (displayedMessages !== messageItems) { displayedMessages = messageItems; ui.messages = messageItems }
        if (displayedTask !== selectedTask) { displayedTask = selectedTask; ui.selectedTask = selectedTask?.let { JSONObject(it.toString()) } }
        ui.viewBranchId = conversationTarget?.branchId
        ui.topic = "$partition:$activeTopic:$scope"
        ui.readerTopic = if (conversationTarget == null) "$partition:$scope" else "$partition:$activeTopic"
        runTranscripts.update("$partition:$activeTopic", client, ui.runs)
        val entry = currentEntry
        ui.newTaskOpening = isNewTaskPage() && (openingNewTaskDraft || (ui.connected && entry?.readingDefaults == true))
        ui.newTaskDefaultsFailed = entry?.failed == true && ui.connected
        renderExecution()
        renderSpace()
        ui.inputEnabled = composer.isEnabled
        ui.hasInput = composer.text.isNotBlank() || ui.attachmentCount > 0
        val waiting = pendingInputScopes[input.scope]
        ui.sendFeedback = when {
            waiting != null && !input.isSubmitting -> mobileText(if (waiting) R.string.send_check_original else R.string.error_command_result_unknown)
            !ui.connected && ui.hasInput -> mobileText(R.string.send_offline)
            else -> sendIssue?.takeIf { it.first == input.scope }?.second.orEmpty()
        }
        ui.canCheckInputReceipt = waiting != null && !input.isSubmitting && ui.connected && checkingReceipts !== client
        val readyToSend = !ui.newTaskOpening && composer.isEnabled && ui.hasInput && waiting == null && !input.isSubmitting && !writingCurrentModel() && ui.conversationReady && !ui.viewingArchived
        ui.sendEnabled = readyToSend && executionConfig != null
        ui.choosePermissionToSend = readyToSend && isNewTaskPage() && ui.executionEnabled && executionConfig == null
        val fallback = if (isNewTaskPage()) entry?.defaults?.model else inheritedModel.takeIf { modelContextKey == modelKey() }
        val selection = model ?: selectedTask?.optJSONObject("modelSelection") ?: fallback
        if (ui.modelPickerOpen) {
            val error = modelEditProblem()
            ui.modelConfirmEnabled = error == null && (localModelScope() || modelPickerEdit != null) && modelWriting == null
            ui.modelConfirmError = error ?: modelReadError
        }
        val resolvedModel = selection?.let { MobileModelControls.resolve(it, ui.models) }
        if (ui.modelSelection?.toString() != resolvedModel?.toString()) ui.modelSelection = resolvedModel
        ui.modelLabel = entry?.defaults?.nameFor(selection) ?: MobileModelControls.model(ui.modelSelection, ui.models)?.optString("displayName")?.takeIf { it.isNotBlank() }
            ?: ui.modelSelection?.optString("modelId")?.takeIf { it.isNotBlank() } ?: if (ui.connected) mobileText(R.string.label_choose_model) else mobileText(R.string.label_disconnected)
        ui.spaceLabel = spaceName ?: mobileText(R.string.label_no_space)
        val taskSpace = selectedTask?.opt("spaceId") as? String
        ui.selectedTaskSpaceLabel = if (taskSpace == null) mobileText(R.string.label_no_space) else ui.spaces.firstOrNull { it.optString("id") == taskSpace }?.optString("name") ?: mobileText(R.string.mobile_space_temporarily_unavailable)
    }
    private fun navigate(screen: MobileScreen) {
        if (ui.screen == MobileScreen.Conversation && screen != ui.screen) input.flush()
        if (screen != ui.screen) { screenHistory.addLast(ui.screen); ui.screen = screen }
        if (screen != MobileScreen.Conversation) hideKeyboard()
    }
    private fun showRoot(screen: MobileScreen) {
        input.flush()
        screenHistory.clear(); ui.screen = screen; hideKeyboard()
        refreshTasks(); refreshSpaces(); refreshPendingOperations()
    }
    private fun goBack() {
        input.flush()
        hideKeyboard()
        ui.screen = screenHistory.removeLastOrNull() ?: MobileScreen.Workbench
        if (isNewTaskPage()) restoreInput()
        if (ui.screen in setOf(MobileScreen.Workbench, MobileScreen.Tasks, MobileScreen.Spaces)) { refreshTasks(); refreshPendingOperations() }
    }
    private fun showTaskFilter(filter: MobileTaskFilter) {
        ui.discovery.archived = false
        ui.taskFilter = filter
        navigate(MobileScreen.Tasks)
        refreshTasks()
        rememberNavigation()
    }
    private fun selectSpaceFilter(value: JSONObject?) {
        ui.selectedSpaceId = value?.opt("id") as? String
        ui.selectedSpaceLabel = value?.optString("name")?.takeIf { it.isNotBlank() } ?: mobileText(R.string.label_all_spaces)
        rememberNavigation()
    }
    private fun chooseSpaceFilter() {
        val values = listOf(JSONObject().put("id", JSONObject.NULL).put("name", mobileText(R.string.label_all_spaces)), JSONObject().put("id", "").put("name", mobileText(R.string.label_no_space))) + ui.spaces
        AlertDialog.Builder(this).setTitle(mobileText(R.string.mobile_view_spaces)).setSingleChoiceItems(values.map { it.getString("name") }.toTypedArray(), values.indexOfFirst { (it.opt("id") as? String) == ui.selectedSpaceId }) { dialog, index ->
            selectSpaceFilter(values[index]); if (ui.discovery.archived) discoveryController.archives(); dialog.dismiss()
        }.setNegativeButton(mobileText(R.string.label_cancel), null).show()
    }
    private fun refreshSpaces() {
        val current = client?.takeIf { it.isConnected } ?: return
        val owner = partition
        work {
            val spaces = mutableListOf<JSONObject>()
            var cursor: String? = null
            do {
                val page = current.call("spaces.list", JSONObject().put("cursor", cursor ?: JSONObject.NULL))
                spaces.addAll(objects(page.getJSONArray("items")))
                cursor = page.optString("nextCursor").takeUnless { it.isBlank() || it == "null" }
            } while (cursor != null)
            onUi {
                if (client !== current || partition != owner) return@onUi
                ui.spaces = spaces
                val selected = ui.selectedSpaceId
                if (!selected.isNullOrEmpty()) {
                    val item = spaces.firstOrNull { it.getString("id") == selected }
                    if (item == null) selectSpaceFilter(null) else ui.selectedSpaceLabel = item.getString("name")
                }
            }
        }
    }
    private fun hideKeyboard() {
        getSystemService(android.view.inputmethod.InputMethodManager::class.java).hideSoftInputFromWindow(composer.windowToken, 0)
        composer.clearFocus()
    }
    private fun refreshDevices() {
        if (demo) {
            ui.deviceLabel = mobileText(R.string.mobile_my_lexora_service)
            ui.devices = listOf(MobileDeviceItem("fixture", mobileText(R.string.mobile_my_lexora_service), mobileText(R.string.mobile_local_interface_demo), true, true))
            return
        }
        val devices = connection.savedDevices()
        ui.devices = devices.map { MobileDeviceItem(it.id, it.name, it.endpoint, it.selected, it.selected && client?.isConnected == true,
            if (it.lastConnectedAt > 0) mobileText(R.string.mobile_last_connected, java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.SHORT, java.text.DateFormat.SHORT, MobileStrings.locale).format(java.util.Date(it.lastConnectedAt))) else null, platform = it.platform) }
        val selected = devices.firstOrNull { it.selected }
        ui.deviceLabel = selected?.name ?: mobileText(R.string.label_connect_service)
        ui.devicePlatform = selected?.platform
    }
    private fun rememberNavigation() {
        if (partition == "unpaired-local" || demo) return
        val value = JSONObject().put("scope", scope).put("topic", activeTopic).put("task", selectedTask ?: JSONObject.NULL)
            .put("selectedSpaceId", ui.selectedSpaceId ?: JSONObject.NULL).put("selectedSpaceLabel", ui.selectedSpaceLabel).put("taskFilter", ui.taskFilter.name)
        navigationStore.edit().putString(partition, value.toString()).apply()
    }
    private fun restoreNavigation(owner: String) {
        val saved = navigationStore.getString(owner, null)?.let { runCatching { JSONObject(it) }.getOrNull() }
        partition = owner; scope = saved?.optString("scope")?.takeIf { it.isNotEmpty() } ?: "global"
        selectedTask = saved?.optJSONObject("task")
        conversationTarget = runCatching { ConversationTarget.fromTopic(saved?.optString("topic") ?: "taskIndex") }.getOrNull()
        messageItems = emptyList(); taskItems = emptyList(); details = emptyMap()
        ui.hasUnplacedInput = false; ui.hasOrphanDownloads = false
        ui.spaces = emptyList(); ui.tasksLoaded = false; ui.taskSyncFailed = false
        resetTaskMarks()
        ui.taskFilter = MobileTaskFilter.entries.firstOrNull { it.name == saved?.optString("taskFilter") } ?: MobileTaskFilter.All
        ui.selectedSpaceId = saved?.opt("selectedSpaceId") as? String
        ui.selectedSpaceLabel = when (ui.selectedSpaceId) { null -> mobileText(R.string.label_all_spaces); "" -> mobileText(R.string.label_no_space); else -> saved?.optString("selectedSpaceLabel").orEmpty() }
    }
    private fun switchDevice(id: String) {
        if (disconnecting) return
        if (id == connection.activeDeviceId()) { if (client?.isConnected != true) resumeConnection(); return }
        rememberNavigation()
        val pending = input.flush()
        disconnecting = true; composer.isEnabled = false; navigation++
        session.invalidate()
        ui.connectionLabel = mobileText(R.string.mobile_switching_services)
        work {
            try {
                pending?.get()
                connection.selectDevice(id)
                val description = connection.description() ?: throw ProtocolFailure("NOT_CONNECTED")
                onUi {
                    restoreNavigation(ProductIdentity.partition(description))
                    activeTopic = "taskIndex"
                    screenHistory.clear(); ui.screen = MobileScreen.Workbench
                    restoreInput(); restoreCachedCatalogs(); refreshDevices(); refreshPendingOperations(); disconnecting = false; resumeConnection()
                }
            } finally { onUi { if (disconnecting) { disconnecting = false; restoreInput() } } }
        }
    }
    private fun manageDevice(id: String) {
        val device = connection.savedDevices().firstOrNull { it.id == id } ?: return
        val actions = if (device.selected) arrayOf(R.string.mobile_rename, R.string.mobile_connection_settings, R.string.mobile_unpair) else arrayOf(R.string.mobile_connect_to_this_service, R.string.mobile_rename, R.string.mobile_remove_phone_connection)
        AlertDialog.Builder(this).setTitle(device.name).setNegativeButton(mobileText(R.string.review_close), null).setItems(actions.map { mobileText(it) }.toTypedArray()) { _, index ->
            when (actions[index]) {
                R.string.mobile_connect_to_this_service -> switchDevice(id)
                R.string.mobile_connection_settings -> showConnection()
                R.string.mobile_unpair -> leavePairing(connection.description())
                R.string.mobile_rename -> {
                    val input = EditText(this).apply { setSingleLine(); setText(device.name); selectAll(); filters = arrayOf(android.text.InputFilter.LengthFilter(80)) }
                    AlertDialog.Builder(this).setTitle(mobileText(R.string.mobile_service_name)).setView(input).setNegativeButton(mobileText(R.string.label_cancel), null).setPositiveButton(mobileText(R.string.save_file)) { _, _ ->
                        val name = input.text.toString().trim()
                        if (name.isNotEmpty()) { connection.renameDevice(id, name); refreshDevices() }
                    }.show()
                }
                else -> AlertDialog.Builder(this).setTitle(mobileText(R.string.mobile_remove, device.name)).setMessage(mobileText(R.string.mobile_only_the_connection_on_this_phone_will_be_removed))
                    .setNegativeButton(mobileText(R.string.mobile_keep), null).setPositiveButton(mobileText(R.string.mobile_remove_2)) { _, _ -> connection.forgetDevice(id); refreshDevices() }.show()
            }
        }.show()
    }
    private fun disconnect() {
        session.disconnect()
        ui.connectionPhase = app.uselexora.mobile.session.MobileConnectionPhase.Idle
        ui.connectionLabel = mobileText(R.string.connection_disconnected); refreshDevices()
    }
    private var pendingInputScopes = emptyMap<MobileComposerSession.Scope, Boolean>()
    private var sendIssue: Pair<MobileComposerSession.Scope, String>? = null
    private var checkingReceipts: ProductClient? = null

    private fun refreshPendingOperations() {
        val owner = partition
        disk.execute {
            val pending = store.pendingComposerCommands(owner)
            val inputs = pending.mapNotNull { item -> item.inputScope?.let { MobileComposerSession.Scope(owner, it) to (item.state == "not_found") } }.toMap()
            val models = pending.filter { it.method == TaskModelTarget.WRITE }.mapNotNull { item -> item.envelope.optJSONObject("intent")?.let { TaskModelLane.of(item.method, it) } }
            onUi {
                if (partition != owner) return@onUi
                pendingTaskModels = owner to models
                sendIssue?.let { (target, message) ->
                    if (target in pendingInputScopes && target !in inputs && message == mobileText(R.string.error_command_result_unknown)) sendIssue = null
                }
                pendingInputScopes = inputs
            }
        }
    }
    private fun checkInputReceipts(current: ProductClient, targetScope: String? = null) {
        val owner = current.identity?.partition ?: return
        val generation = connectionGeneration
        if (!foreground || checkingReceipts === current || partition != owner) return
        checkingReceipts = current
        work {
            try {
                for (item in store.pendingComposerCommands(owner)) {
                    if (!foreground || connectionGeneration != generation || !current.isConnected) break
                    val source = item.inputScope ?: continue
                    if (targetScope != null && source != targetScope) continue
                    val checked = try { CommandOutbox(store).reconcile(current, item) } catch (_: Exception) { continue }
                    onUi {
                        if (partition != owner || client !== current || !foreground || scope != source) return@onUi
                        when (checked.state) {
                            "accepted" -> when (checked.localEffect?.optString("kind")) {
                                "taskModel" -> { useConfirmedTaskModel(owner, source); refreshModelContext() }
                                "submit", "send" -> acceptedInput(current, ConversationTarget.fromTarget(checked.receipt!!.getJSONObject("target")))
                                else -> restoreInput()
                            }
                            "not_found" -> if (targetScope != null) reviewMissingInput(current, checked)
                            "rejected" -> sendIssue = input.scope to MobileFailurePresentation.message(MobileOperationFailure.from(ProtocolFailure(checked.receipt!!.optString("errorCode"))))
                            "not_received" -> sendIssue = input.scope to mobileText(R.string.send_not_received)
                        }
                    }
                }
            } finally { onUi { if (checkingReceipts === current) checkingReceipts = null; refreshPendingOperations() } }
        }
    }
    private fun reviewMissingInput(current: ProductClient, checked: app.uselexora.mobile.storage.OutboxItem) {
        val owner = operationOwner()
        AlertDialog.Builder(this).setMessage(mobileText(R.string.send_review_missing))
            .setNegativeButton(mobileText(R.string.label_cancel), null)
            .setPositiveButton(mobileText(R.string.send_back_to_edit)) { _, _ ->
                if (isCurrent(owner) && foreground && current.isConnected) work {
                    val fresh = CommandOutbox(store).reconcile(current, checked)
                    if (fresh.state == "not_found") store.releaseComposerCommand(fresh, reviewed = true)
                    onUi {
                        refreshPendingOperations()
                        if (isCurrent(owner) && fresh.state == "accepted") {
                            if (fresh.localEffect?.optString("kind") in setOf("send", "submit")) acceptedInput(current, ConversationTarget.fromTarget(fresh.receipt!!.getJSONObject("target")))
                            else restoreInput()
                        }
                    }
                }
            }.show()
    }
    private fun loadMessageDetail(message: JSONObject) {
        val id = message.getString("id")
        if (details[id]?.loading == true) return
        val topic = ui.topic
        val sourceBody = message.getJSONObject("body").toString()
        val owner = partition
        val current = client
        details = details + (id to MobileMessageDetail(loading = true, sourceBody = sourceBody))
        work {
            var resource: JSONObject? = null
            try {
                if (current?.isConnected != true) throw ProtocolFailure("NOT_CONNECTED")
                val body = message.getJSONObject("body")
                val resourceId = body.optString("resourceId").takeIf { it.isNotEmpty() }
                    ?: body.optJSONObject("content")?.optString("contentReference")?.takeIf { it.isNotEmpty() }
                    ?: "message:$id"
                val resolved = current.callValue("resources.get", JSONObject().put("resourceId", resourceId)) as? JSONObject ?: throw ProtocolFailure("RESOURCE_UNAVAILABLE")
                if (resolved.optString("availability") != "ready") throw ProtocolFailure("RESOURCE_UNAVAILABLE")
                resource = resolved
                val presentation = app.uselexora.mobile.protocol.MobileMessagePresentation
                val result = if (resolved.getString("sizeBytes").toLong() > presentation.MAX_INLINE_DETAIL_BYTES) {
                    MobileMessageDetail(resource = resolved, notice = mobileText(R.string.mobile_this_content_is_long_preview_save_or_share_it))
                } else {
                    presentation.readDetail(files.download(current, resolved, previewOnly = true), resolved, schemas, objects(message.optJSONArray("resources") ?: JSONArray()))
                }
                onUi { if (ui.topic == topic && partition == owner && client === current) details = details + (id to result.copy(sourceBody = sourceBody)) }
            } catch (failure: Exception) {
                val error = when ((failure as? ProtocolFailure)?.code) {
                    "NOT_CONNECTED", "SERVICE_UNREACHABLE", "CONNECTION_CLOSED" -> mobileText(R.string.mobile_connection_interrupted_reconnect_and_try_again)
                    "RESOURCE_UNAVAILABLE", "OBJECT_DELETED" -> mobileText(R.string.mobile_this_message_is_temporarily_unavailable_try_again_later)
                    "LOCAL_CACHE_FULL", "LOCAL_STORAGE_FAILED" -> mobileText(R.string.mobile_phone_storage_is_full_or_unwritable_free_up_space)
                    "CONTENT_HASH_MISMATCH", "SOURCE_CHANGED" -> mobileText(R.string.mobile_content_changed_or_verification_failed_load_it_again)
                    "FILE_TOO_LARGE" -> mobileText(R.string.mobile_content_exceeds_the_current_download_limit_try_again_later)
                    else -> mobileText(R.string.mobile_could_not_load_details_please_retry)
                }
                onUi { if (ui.topic == topic && partition == owner && client === current) details = details + (id to MobileMessageDetail(error = error, resource = resource, sourceBody = sourceBody)) }
            }
        }
    }
    private fun fixtureMessages(): List<JSONObject> = listOf(
        JSONObject().put("id", "demo-user").put("role", "user").put("body", JSONObject().put("kind", "text").put("text", mobileText(R.string.mobile_help_me_review_the_mobile_redesign_especially_service_switching))),
        JSONObject().put("id", "demo-start").put("role", "assistant").put("body", JSONObject().put("kind", "text").put("text", mobileText(R.string.mobile_i_will_review_tasks_services_and_input_then_suggest))),
        JSONObject().put("id", "demo-tool").put("role", "tool").put("runId", "demo-run").put("tool", JSONObject().put("name", "read").put("isError", false)).put("body", JSONObject().put("kind", "text").put("text", mobileText(R.string.mobile_checked_the_task_page_and_service_list))),
        JSONObject().put("id", "demo-result").put("role", "assistant").put("body", JSONObject().put("kind", "text").put("text", mobileText(R.string.mobile_keep_common_actions_close_the_task_list_highlights_progress)))
    )
    private fun persistInput(text: CharSequence, keepSettings: Boolean = true) {
        if (!composer.isEnabled) return
        saveFeedback("")
        val selection = model; val execution = executionConfig; val space = spaceId; val name = spaceName
        if (keepSettings || text.isNotEmpty()) savedExecution = execution
        input.persist({ ComposerEdit(text.toString(), selection?.toString(), execution?.toString(), space, name, keepSettings) }, saved = { saveFeedback(mobileText(R.string.mobile_saved_on_phone)) }, failed = { saveFeedback(mobileText(R.string.mobile_save_failed_keep_this_input_open), false) })
    }
    private fun clearConversationState() {
        ui.taskFiles = null
        readyContext = null; ui.conversationReady = false; ui.viewingArchived = false
        historyRequest++; ui.membersChanging = false; ui.membersLoading = false; ui.membersError = ""
        liveMessages = emptyList(); historicalMessages = emptyList()
        ui.historyPinned = false; ui.historyCursor = null; ui.historyHasMore = true; ui.historyLoading = false; ui.historyError = ""
        ui.anchorMessageId = null; ui.anchorRequestId = null; ui.membersOpen = false; ui.members = null
        readModel.resetTopic(); ui.readingCached = false; projectedTaskSource = null
        resultReadKey = null; ui.resultRunId = null
        readResults.clear(); suppressedReadResults.clear()
        questions.close(); ui.questions = emptyList(); ui.runs = emptyList(); ui.queueItems = emptyList(); ui.approvalItems = emptyList(); ui.stoppingRunId = null
        ui.branches = emptyList(); ui.branchesLoading = false; ui.branchesFailed = false
    }
    private fun bindQuestions() {
        val target = conversationTarget?.takeIf { ui.screen == MobileScreen.Conversation }
        questions.bind(client, target?.conversationId, target?.branchId)
    }
    private fun newTask() {
        navigation++
        clearConversationState()
        scope = DraftContext.newTaskKey(ui.selectedSpaceId); selectedTask = null; messageItems = emptyList(); activeTopic = "taskIndex"
        subscription?.subscribe(activeTopic)
        navigate(MobileScreen.Conversation)
        restoreInput(); syncUi(); ui.notice = ""
    }
    private fun isNewTaskPage() = ui.screen == MobileScreen.Conversation && selectedTask == null && conversationTarget == null
    private fun restoreInput(retryDefaults: Boolean = false) {
        val target = scope
        val task = selectedTask?.let { JSONObject(it.toString()) }
        val newTask = task == null && conversationTarget == null
        if (!input.displayingScope) savedExecution = null
        val opening = isNewTaskPage()
        if (opening && currentEntry == null) openingNewTaskDraft = true
        if (opening) prepareNewTaskEntry(retryDefaults) else {
            newTaskEntry = null
            if (!newTask) refreshModelContext()
        }
        if (!input.displayingScope) {
            writingView = true; composer.setText(""); writingView = false
            composer.isEnabled = false; ui.sendEnabled = false; ui.inputEnabled = false; ui.executionEnabled = false; ui.spaceEnabled = false; model = null; ui.attachments = emptyList(); ui.attachmentCount = 0; saveFeedback(if (newTask) "" else mobileText(R.string.mobile_opening_draft), false)
        }
        input.restore(::draftAttachments, ready = { current, attachments ->
            openingNewTaskDraft = false
            writingView = true
            composer.setText(current?.value?.optJSONObject("content")?.let { MobileContentAdapter.text(it) } ?: "")
            composer.setSelection(composer.text.length)
            composer.isEnabled = current == null || MobileContentAdapter.canEditAsText(current.value.getJSONObject("content"))
            ui.sendEnabled = composer.isEnabled; ui.inputEnabled = composer.isEnabled
            writingView = false
            ui.attachmentCount = current?.value?.optJSONObject("content")?.optJSONArray("panelResourceIds")?.length() ?: 0
            ui.attachments = attachments
            saveFeedback(if (!composer.isEnabled) mobileText(R.string.mobile_edit_this_content_on_the_desktop) else "", false)
            model = current?.value?.optJSONObject("modelSelection")
            savedExecution = if (newTask && !demo) current?.value?.optJSONObject("executionConfig") else ExecutionSettings.resolve(current?.value, task)
            spaceId = if (current == null && target == DraftContext.newTaskKey(ui.selectedSpaceId)) ui.selectedSpaceId?.takeIf { it.isNotBlank() }
                else DraftContext.spaceId(current?.value)
            spaceName = current?.value?.optString("spaceName")?.takeUnless { it.isEmpty() || it == "null" }
                ?: ui.spaces.firstOrNull { it.optString("id") == spaceId }?.optString("name")
                ?: ui.selectedSpaceLabel.takeIf { spaceId != null && spaceId == ui.selectedSpaceId }
            renderSpace()
            renderExecution()
            when (HistorySource.fromScope(DraftContext.target(target))?.kind) {
                HistorySource.Kind.Followup -> ui.notice = mobileText(R.string.mobile_continuing_a_previous_reply_sending_creates_a_new_branch)
                HistorySource.Kind.Edit -> ui.notice = mobileText(R.string.mobile_editing_previous_input_sending_creates_a_new_branch)
                null -> Unit
            }

        }, failed = { openingNewTaskDraft = false; saveFeedback(mobileText(R.string.mobile_could_not_open_the_draft_please_retry), false) })
    }
    private fun resumeConnection() = session.resume()
    private fun openDiscoveryHit(hit: JSONObject) {
        val current = client?.takeIf { it.isConnected } ?: run { ui.notice = MobileFailurePresentation.NETWORK_UNAVAILABLE_NOTICE; return }
        val owner = partition; val visit = ++navigation
        val archived = hit.optBoolean("archived")
        work {
            val task = current.callValue("conversations.get", JSONObject().put("conversationId", hit.getString("conversationId"))) as? JSONObject ?: throw ProtocolFailure("OBJECT_DELETED")
            val target = ConversationTarget(task.getString("id"), hit.optString("branchId").ifBlank { task.getString("activeBranchId") })
            val window = if (hit.optString("kind") == "message") current.call("conversations.getMessageWindow", target.params().put("messageId", hit.getString("messageId")).put("limit", 50)) else null
            onUi {
                if (partition != owner || client !== current || visit != navigation) return@onUi
                showTask(task, target = target)
                ui.viewingArchived = archived
                if (window != null) {
                    historicalMessages = visibleMessages(objects(window.getJSONArray("items")))
                    ui.historyPinned = true
                    ui.historyCursor = window.opt("nextCursor") as? String
                    ui.historyHasMore = ui.historyCursor != null
                    ui.anchorMessageId = window.getString("anchorMessageId"); ui.anchorRequestId = java.util.UUID.randomUUID().toString()
                    messageItems = historicalMessages; renderRows()
                }
                syncUi()
            }
        }
    }
    private fun restoreArchivedTask(task: JSONObject) {
        val current = client?.takeIf { it.isConnected && it.supports("conversations.restoreArchive") } ?: return
        val owner = operationOwner()
        AlertDialog.Builder(this).setTitle(mobileText(R.string.mobile_restore_task)).setMessage(mobileText(R.string.mobile_restore_task_confirm))
            .setNegativeButton(mobileText(R.string.label_cancel), null).setPositiveButton(mobileText(R.string.mobile_restore_task)) { _, _ ->
                if (!isCurrent(owner) || client !== current) return@setPositiveButton
                work {
                    requireAccepted(CommandOutbox(store).submit(current, "conversations.restoreArchive", JSONObject().put("conversationId", task.getString("id")).put("expectedRevision", task.getString("revision"))))
                    onUi { if (isCurrent(owner)) { ui.discovery.archiveItems = ui.discovery.archiveItems.filter { it.optString("id") != task.getString("id") }; discoveryController.archives() } }
                }
            }.show()
    }
    private fun changeMember(action: MobileAction, member: JSONObject) {
        val current = client?.takeIf { it.isConnected } ?: return
        val snapshot = ui.members ?: return
        val task = selectedTask ?: return
        if (ui.membersChanging || ui.viewingArchived || !ui.conversationReady || !session.isSynchronized) return
        if (input.isSubmitting) { ui.membersError = mobileText(R.string.error_command_result_unknown); return }
        val method = when (action) { MobileAction.AddMember -> "conversations.addMember"; MobileAction.RemoveMember -> "conversations.removeMember"; else -> "conversations.setBuddy" }
        if (!current.supports(method)) return
        val owner = operationOwner()
        val intent = JSONObject().put("conversationId", task.getString("id")).put("buddyId", if (action == MobileAction.AddMember) member.getString("id") else member.getString("actorId")).put("expectedRevision", snapshot.getString("revision"))
        val submit = {
            if (isCurrent(owner) && client === current && !ui.membersChanging) {
                ui.membersChanging = true
                work {
                    try {
                        store.draft(owner.partition, owner.inputScope)?.let { if (store.hasPendingDraftCommand(it)) throw ProtocolFailure("COMMAND_RESULT_UNKNOWN") }
                        requireAccepted(CommandOutbox(store).submit(current, method, intent))
                        onUi {
                            if (isCurrent(owner)) {
                                ui.membersChanging = false
                                if (action == MobileAction.SelectBuddy) { model = null; persistInput(composer.text.toString()); refreshModelContext() }
                                discoveryController.members()
                            }
                        }
                    } catch (error: Exception) { onUi { if (isCurrent(owner)) { ui.membersChanging = false; ui.membersError = MobileFailurePresentation.message(MobileOperationFailure.from(error)) } } }
                }
            }
        }
        if (action == MobileAction.RemoveMember) AlertDialog.Builder(this).setTitle(mobileText(R.string.mobile_remove_partner)).setMessage(mobileText(R.string.mobile_remove_partner_confirm)).setNegativeButton(mobileText(R.string.label_cancel), null).setPositiveButton(mobileText(R.string.mobile_remove_partner)) { _, _ -> submit() }.show()
        else submit()
    }
    private fun returnLatest() {
        if (!ui.historyPinned) return
        val target = conversationTarget ?: return
        val current = client?.takeIf { it.isConnected } ?: run { ui.historyError = MobileFailurePresentation.NETWORK_UNAVAILABLE_NOTICE; return }
        val context = liveContext(); val visit = navigation; val request = ++historyRequest
        ui.historyLoading = true; ui.historyError = ""
        work {
            try {
                val result = if (current.supports("conversations.getRecentWindow")) current.call("conversations.getRecentWindow", target.params()) else current.call("conversations.listMessages", target.params().put("limit", 50))
                onUi {
                    if (context != liveContext() || visit != navigation || historyRequest != request) return@onUi
                    liveMessages = visibleMessages(objects(result.getJSONArray("items")))
                    historicalMessages = emptyList(); messageItems = liveMessages
                    ui.historyPinned = false; ui.anchorMessageId = null; ui.anchorRequestId = null
                    ui.historyCursor = result.opt("nextCursor") as? String; ui.historyHasMore = ui.historyCursor != null
                    ui.historyLoading = false; renderRows()
                    subscription?.subscribe(activeTopic)
                }
            } catch (error: Exception) { onUi { if (context == liveContext() && visit == navigation && historyRequest == request) { ui.historyLoading = false; ui.historyError = MobileFailurePresentation.message(MobileOperationFailure.from(error)) } } }
        }
    }
    private fun refreshTasks() {
        clearConversationState()
        if (demo) { selectedTask = null; activeTopic = "taskIndex"; loadFixture(); return }
        val generation = ++navigation
        activeTopic = "taskIndex"
        subscription?.let { selectedTask = null; it.subscribe(activeTopic); return }
        val current = client?.takeIf { it.isConnected } ?: return
        val owner = partition
        work {
            val items = mutableListOf<JSONObject>()
            var cursor: String? = null
            do {
                val page = current.call("conversations.list", JSONObject().put("cursor", cursor ?: JSONObject.NULL))
                items.addAll(objects(page.getJSONArray("items")))
                cursor = page.optString("nextCursor").takeUnless { it.isBlank() || it == "null" }
            } while (cursor != null)
            onUi {
                if (generation != navigation || client !== current || partition != owner) return@onUi
                taskItems = items; ui.tasksLoaded = true; selectedTask = null; refreshTaskMarks(); renderRows(); ui.notice = ""
            }
        }
    }
    private fun resetTaskMarks() = readModel.resetMarks()
    private fun refreshTaskMarks() { if (!demo && ui.tasksLoaded) readModel.refreshMarks() }
    private fun branchPreference(owner: String, taskId: String) = "view-branch:$owner:$taskId"
    private fun readBranches(current: ProductClient, taskId: String): List<JSONObject> {
        val result = mutableListOf<JSONObject>()
        var cursor: String? = null
        do {
            val page = current.call("conversations.listBranches", JSONObject().put("conversationId", taskId).put("cursor", cursor ?: JSONObject.NULL))
            result.addAll(objects(page.getJSONArray("items")))
            cursor = page.optString("nextCursor").takeUnless { it.isBlank() || it == "null" }
        } while (cursor != null)
        return result
    }
    private fun openTask(task: JSONObject) {
        val saved = navigationStore.getString(branchPreference(partition, task.getString("id")), null)
        val target = if (saved != null && !demo) ConversationTarget(task.getString("id"), saved) else ConversationTarget.fromTask(task)
        showTask(task, target = target)
    }
    private fun openTaskAt(task: JSONObject, matching: (JSONObject) -> Boolean) {
        val current = client?.takeIf { it.isConnected } ?: run { openTask(task); return }
        val owner = partition; val generation = ++navigation
        val preferred = navigationStore.getString(branchPreference(owner, task.getString("id")), null)
        work {
            val branches = readBranches(current, task.getString("id"))
            val matchingBranches = branches.filter(matching)
            val chosen = matchingBranches.firstOrNull { it.optString("id") == preferred } ?: matchingBranches.firstOrNull()
                ?: branches.firstOrNull { it.optString("id") == preferred }
            val target = chosen?.let { ConversationTarget(task.getString("id"), it.getString("id")) } ?: ConversationTarget.fromTask(task)
            onUi { if (client === current && partition == owner && navigation == generation) { showTask(task, branches, target) } }
        }
    }
    private fun loadBranches() {
        val task = selectedTask ?: return
        val current = client?.takeIf { it.isConnected } ?: return
        val owner = partition; val topic = activeTopic
        ui.branchesLoading = true; ui.branchesFailed = false
        work {
            try {
                val branches = readBranches(current, task.getString("id"))
                readModel.rememberBranches(owner, task.getString("id"), branches)
                onUi { if (client === current && partition == owner && activeTopic == topic) {
                    ui.branches = branches; ui.branchesLoading = false
                    if (branches.isNotEmpty() && branches.none { it.optString("id") == conversationTarget?.branchId }) {
                        val fallback = branches.firstOrNull { it.optString("id") == taskItems.firstOrNull { value -> value.optString("id") == task.getString("id") }?.optString("activeBranchId") } ?: branches.first()
                        showTask(task, branches, ConversationTarget(task.getString("id"), fallback.getString("id")))
                    }
                } }
            } catch (error: Exception) {
                onUi { if (client === current && partition == owner && activeTopic == topic) { ui.branchesLoading = false; ui.branchesFailed = true } }
                throw error
            }
        }
    }
    private fun selectBranch(branch: JSONObject) {
        val task = selectedTask ?: return
        if (branch.optString("conversationId") != task.getString("id") || ui.branches.none { it.optString("id") == branch.optString("id") }) return
        if (branch.getString("id") == conversationTarget?.branchId) return
        val branches = ui.branches
        showTask(task, branches, ConversationTarget(task.getString("id"), branch.getString("id")))
    }
    private fun refreshConversation() {
        val task = selectedTask ?: return
        subscription?.subscribe(activeTopic) ?: showTask(JSONObject(task.toString()))
        questions.close(); bindQuestions(); loadBranches(); refreshPendingOperations()
    }
    private fun showTask(task: JSONObject, branches: List<JSONObject>? = null, target: ConversationTarget = conversationTarget?.takeIf { it.conversationId == task.getString("id") } ?: ConversationTarget.fromTask(task)) {
        if (target.conversationId != task.getString("id")) throw ProtocolFailure("SOURCE_CHANGED")
        val knownBranches = branches ?: ui.branches.takeIf { selectedTask?.optString("id") == task.optString("id") } ?: emptyList()
        val archived = (ui.viewingArchived && selectedTask?.optString("id") == task.optString("id")) || (task.has("archivedAt") && !task.isNull("archivedAt"))
        clearConversationState()
        ui.viewingArchived = archived
        val generation = ++navigation
        selectedTask = task
        conversationTarget = target
        if (!demo) navigationStore.edit().putString(branchPreference(partition, target.conversationId), target.branchId).apply()
        messageItems = emptyList(); details = emptyMap(); navigate(MobileScreen.Conversation)
        scope = target.localKey
        restoreInput()
        restoreCachedConversation()
        bindQuestions()
        ui.branches = knownBranches
        if (knownBranches.none { it.optString("id") == target.branchId }) loadBranches()
        if (demo) { messageItems = fixtureMessages(); renderRows(); return }
        val current = client?.takeIf { it.isConnected } ?: return
        subscription?.let { it.subscribe(activeTopic); return }
        work {
            val result = current.call("conversations.listMessages", target.params())
            val messages = visibleMessages(objects(result.getJSONArray("items")))
            onUi { if (generation != navigation || client !== current) return@onUi; messageItems = messages; renderRows(); ui.notice = "" }
        }
    }
    private fun renderProjection(topic: String, items: List<JSONObject>) {
        if (topic != activeTopic) return
        if (topic == "taskIndex") {
            taskItems = items
            ui.tasksLoaded = true
            refreshTaskMarks()
            renderRows()
        } else {
            val messages = visibleMessages(items.filter { it.optString("entity") == "message" }.map { it.getJSONObject("value") })
            liveMessages = messages
            messageItems = if (ui.historyPinned) historicalMessages else mergeMessages(historicalMessages, liveMessages)
            val window = items.firstOrNull { it.optString("entity") == "historyWindow" }?.getJSONObject("value")
            if (!ui.historyPinned && historicalMessages.isEmpty()) {
                ui.historyCursor = window?.opt("nextCursor") as? String
                ui.historyHasMore = window?.optBoolean("hasMore") == true
            }
            ui.runs = items.filter { it.optString("entity") == "run" }.map { it.getJSONObject("value") }
            ui.queueItems = items.filter { it.optString("entity") == "queue" }.map { it.getJSONObject("value") }
            ui.approvalItems = items.filter { it.optString("entity") == "approval" }.map { it.getJSONObject("value") }
            if (ui.runs.none { it.optString("id") == ui.stoppingRunId && it.optString("status") in setOf("queued", "running") }) ui.stoppingRunId = null
            items.firstOrNull { it.optString("entity") == "task" }?.getJSONObject("value")?.let {
                if (projectedTaskSource !== it) { projectedTaskSource = it; acceptTaskProjection(it) }
            }
            if (modelTaskRevision != selectedTask?.optString("revision")) refreshModelContext()
            refreshReaderResult(); bindQuestions(); renderRows()
        }
    }
    private fun refreshReaderResult() {
        val task = selectedTask ?: return
        val current = client?.takeIf { it.isConnected && it.supports("taskMarks.states") } ?: return
        val completed = ui.runs.filter { it.optString("executionKind") == "root" && it.optString("purpose") != "conversation.compaction" && it.optString("status") in setOf("completed", "failed") }.map { it.getString("id") }.sorted()
        val owner = partition; val topic = activeTopic; val generation = connectionGeneration; val visit = navigation
        val key = "$owner:$topic:$generation:$visit:${completed.joinToString(",")}"
        if (resultReadKey == key) return
        resultReadKey = key; ui.resultRunId = null
        if (completed.isEmpty()) return
        work {
            val states = current.callValue("taskMarks.states", JSONObject().put("conversationIds", JSONArray().put(task.getString("id")))) as? JSONArray ?: throw ProtocolFailure("PROTOCOL_INCOMPATIBLE")
            val state = objects(states).singleOrNull { it.optString("conversationId") == task.getString("id") } ?: return@work
            onUi {
                if (resultReadKey == key && client === current && partition == owner && activeTopic == topic && connectionGeneration == generation && navigation == visit) {
                    ui.resultRunId = state.optString("resultRunId").takeIf { state.optBoolean("unread") && it in completed }
                }
            }
        }
    }
    private fun readVisibleResult(runId: String) {
        if (demo || !foreground || ui.readingCached || ui.screen != MobileScreen.Conversation) return
        val task = selectedTask ?: return
        if (ui.resultRunId != runId) return
        val current = client?.takeIf { it.isConnected && it.supports("taskMarks.setRead") } ?: return
        val taskId = task.getString("id")
        val owner = partition; val topic = activeTopic; val generation = connectionGeneration; val visit = navigation
        val key = "$owner:$taskId:$runId"
        if (key in suppressedReadResults || !readResults.add(key)) return
        work {
            fun currentVisit() = foreground && ui.screen == MobileScreen.Conversation && client === current && partition == owner && activeTopic == topic && connectionGeneration == generation && navigation == visit && key !in suppressedReadResults
            if (!currentVisit()) return@work
            val states = current.callValue("taskMarks.states", JSONObject().put("conversationIds", JSONArray().put(taskId))) as? JSONArray ?: throw ProtocolFailure("PROTOCOL_INCOMPATIBLE")
            val state = objects(states).singleOrNull { it.optString("conversationId") == taskId } ?: return@work
            if (!state.optBoolean("unread") || state.optString("resultRunId") != runId || !currentVisit()) return@work
            CommandOutbox(store).submit(current, "taskMarks.setRead", JSONObject().put("conversationId", taskId).put("resultRunId", runId).put("readRevision", state.getString("readRevision")).put("read", true))
        }
    }
    private fun renderRows() { syncUi() }
    private fun send(method: String = "chat.startTurn", extra: JSONObject = JSONObject(), reviewed: LocalDraft? = null) {
        if (!demo && client?.isConnected != true) { syncUi(); return }
        if (ui.newTaskOpening || input.scope in pendingInputScopes || input.isSubmitting) return
        if (writingCurrentModel()) {
            if (pendingModel()) { sendIssue = input.scope to mobileText(R.string.error_command_result_unknown); syncUi() }
            return
        }
        if (!composer.isEnabled) { ui.notice = mobileText(R.string.mobile_input_is_being_restored_or_requires_desktop_editing_the); return }
        if (!demo && (!ui.conversationReady || ui.viewingArchived || (conversationTarget != null && (!session.isSynchronized || readyContext != liveContext())))) {
            ui.notice = mobileText(if (ui.viewingArchived) R.string.mobile_archived_read_only else if (ui.syncFailure.isNotBlank()) R.string.mobile_sync_failed_input else R.string.mobile_sync_required); return
        }
        if (demo) { val text = composer.text.toString(); if (text.isBlank()) return; input.flush(); messageItems = messageItems + JSONObject().put("id", store.newId()).put("role", "user").put("body", JSONObject().put("kind", "text").put("text", text)); syncUi(); ui.notice = mobileText(R.string.mobile_demo_accepted_no_service_task_will_run); streamFixture(); return }
        val sendingClient = client?.takeIf { it.isConnected && it.identity?.partition == partition && foreground } ?: return
        val owner = operationOwner()
        sendIssue = null
        val execution = executionConfig ?: run { if (ui.choosePermissionToSend) chooseExecution(); return }
        input.submit(sendingClient, method, extra, execution, ::work, reviewed = reviewed, accepted = { result ->
            if (isCurrent(owner)) acceptedInput(sendingClient, result.target)
        }, failed = { failure ->
            if (isCurrent(owner)) {
                val review = failure.cause as? app.uselexora.mobile.storage.SubmittedTextReview
                if (review == null) sendIssue = input.scope to MobileFailurePresentation.message(failure)
                else AlertDialog.Builder(this).setMessage(mobileText(R.string.send_review_text))
                    .setNegativeButton(mobileText(R.string.send_back_to_edit), null)
                    .setPositiveButton(mobileText(R.string.send_again)) { _, _ ->
                        if (isCurrent(owner)) send(method, extra, reviewed = review.draft)
                    }.show()
            }
        }, settled = ::refreshPendingOperations)
        syncUi()
    }
    private fun acceptedInput(current: ProductClient, target: ConversationTarget) {
        sendIssue = null
        if (ui.screen != MobileScreen.Conversation) return
        val known = selectedTask?.takeIf { it.optString("id") == target.conversationId } ?: taskItems.firstOrNull { it.optString("id") == target.conversationId }
        if (known != null) { showTask(known, target = target); return }
        val owner = operationOwner()
        restoreInput()
        work {
            val task = current.call("conversations.get", JSONObject().put("conversationId", target.conversationId))
            onUi { if (isCurrent(owner)) showTask(task, target = target) }
        }
    }
    private fun renderSpace() {
        ui.spaceVisible = selectedTask == null && scope.startsWith("draft:")
        ui.spaceEnabled = composer.isEnabled
        ui.spaceLabel = spaceName ?: mobileText(R.string.label_no_space)
    }
    private fun chooseSpace(cursor: String? = null) {
        val owner = partition
        val target = scope
        if (!target.startsWith("draft:") || selectedTask != null || !composer.isEnabled) return
        work {
            val current = connected()
            if (current.identity?.partition != owner) throw ProtocolFailure("DATA_GENERATION_CHANGED")
            val result = current.call("spaces.list", JSONObject().put("cursor", cursor ?: JSONObject.NULL))
            val spaces = objects(result.getJSONArray("items"))
            onUi {
                if (partition != owner || scope != target || selectedTask != null || !composer.isEnabled) return@onUi
                val labels = arrayOf(mobileText(R.string.label_no_space)) + spaces.map { it.getString("name") }.toTypedArray()
                val dialog = AlertDialog.Builder(this).setTitle(mobileText(R.string.mobile_choose_an_existing_service_space)).setItems(labels) { _, index ->
                    if (partition == owner && scope == target && composer.isEnabled) {
                        val selected = spaces.getOrNull(index - 1)
                        spaceId = selected?.getString("id"); spaceName = selected?.getString("name")
                        renderSpace(); persistInput(composer.text.toString())
                    }
                }.setNegativeButton(mobileText(R.string.label_cancel), null)
                if (!result.isNull("nextCursor")) dialog.setNeutralButton(mobileText(R.string.next_page)) { _, _ -> if (partition == owner && scope == target) chooseSpace(result.getString("nextCursor")) }
                dialog.show()
            }
        }
    }
    private fun recoveryTargetLabel(owner: String, taskId: String): String? {
        if (partition != owner) return null
        val task = taskItems.firstOrNull { it.optString("id") == taskId } ?: selectedTask?.takeIf { it.optString("id") == taskId }
        return task?.optString("title")?.takeUnless { it.isBlank() || it == "null" }
    }
    private var modelPickerOwner: MobileOperationOwner? = null
    private var modelPickerTask: TaskModelTarget? = null
    private var modelPickerEdit: TaskModelEdit? = null
    private var modelPickerRequest = 0L
    private var modelReadError = ""
    private var modelWriting: MobileOperationOwner? = null
    private var pendingTaskModels: Pair<String, List<TaskModelLane>>? = null
    private fun pendingModel(actorId: String? = null): Boolean {
        val id = conversationTarget?.conversationId ?: return false
        return pendingTaskModels?.takeIf { it.first == partition }?.second?.any { it.overlaps(TaskModelLane(id, actorId)) } == true
    }
    private fun useConfirmedTaskModel(owner: String, target: String) {
        disk.execute { onUi { if (partition == owner && scope == target) model = null } }
    }
    private fun writingCurrentModel() = pendingModel() || modelWriting?.let { it.partition == partition && it.inputScope == scope } == true
    private fun localModelScope() = demo || scope.startsWith("message-edit:") || scope.startsWith("message-followup:") || (selectedTask == null && conversationTarget == null && (scope == "global" || scope.startsWith("draft:") || scope.startsWith("space:")))
    private fun modelKey() = "$partition:$scope:${selectedTask?.optString("buddyId")}:${selectedTask?.optString("revision")}"
    private fun modelTarget() = TaskModelTarget.capture(selectedTask, conversationTarget, scope)
    private fun acceptTaskProjection(value: JSONObject) {
        val previous = selectedTask
        if (previous != null && previous.optString("id") == value.optString("id") && previous.optLong("revision", -1) > value.optLong("revision", -1)) return
        selectedTask = JSONObject(value.toString())
    }
    private fun modelEditProblem(): String? {
        if (modelPickerOwner != operationOwner()) return mobileText(R.string.error_source_changed)
        if (localModelScope()) return null
        val current = client ?: return mobileText(R.string.error_not_connected)
        return when {
            !current.isConnected || current.identity?.partition != partition -> mobileText(R.string.error_not_connected)
            ui.viewingArchived -> mobileText(R.string.mobile_archived_read_only)
            !ui.conversationReady || !session.isSynchronized || readyContext != liveContext() -> mobileText(R.string.mobile_sync_required)
            !current.supports(TaskModelTarget.READ) -> mobileText(R.string.error_method_not_available)
            !current.supports(TaskModelTarget.WRITE) -> mobileText(R.string.error_not_authorized)
            modelPickerTask == null || modelTarget() != modelPickerTask -> mobileText(R.string.error_source_changed)
            input.isSubmitting || ui.membersChanging || pendingModel(modelPickerTask?.actorId) -> mobileText(R.string.error_command_result_unknown)
            else -> null
        }
    }
    private var modelTaskRevision: String? = null
    private fun refreshModelContext(refreshCatalog: Boolean = false) {
        val current = client?.takeIf { it.isConnected } ?: return
        val owner = partition; val target = scope; val task = selectedTask
        val request = ++modelContextRequest
        modelTaskRevision = task?.optString("revision")
        val key = modelKey()
        if (modelContextKey != key) { inheritedModel = null; modelContextKey = key }
        refreshModelCatalog(current, refreshCatalog)
        work {
            try {
                val selection = if (current.supports("providers.getInputSelection")) current.call("providers.getInputSelection", JSONObject().apply { task?.let { put("conversationId", it.getString("id")) } }).optJSONObject("modelSelection") else task?.optJSONObject("modelSelection")
                onUi {
                    if (client === current && partition == owner && scope == target && modelKey() == key && request == modelContextRequest) {
                        inheritedModel = selection
                    }
                }
            } catch (_: Exception) {
                onUi { if (client === current && partition == owner && scope == target && request == modelContextRequest) { ui.modelsLoading = false; ui.modelsError = mobileText(R.string.models_load_failed) } }
            }
        }
    }
    private fun refreshModelCatalog(current: ProductClient, force: Boolean = false) = readModel.refreshCatalog(current, force)
    private fun restoreCachedCatalogs() { if (!demo) readModel.restoreCatalogs() }
    private fun restoreCachedConversation() {
        ui.readingCached = false
        if (!demo) selectedTask?.getString("id")?.let(readModel::restoreConversation)
    }
    private fun chooseModel(quickSelection: JSONObject? = null) {
        hideKeyboard()
        val owner = operationOwner()
        val target = modelTarget()
        val request = ++modelPickerRequest
        modelPickerOwner = owner; modelPickerTask = target; modelPickerEdit = null; modelReadError = ""
        ui.modelPickerOpen = true
        if (demo) {
            if (ui.models.isEmpty()) ui.models = listOf(JSONObject().put("modelId", "demo").put("providerId", "demo").put("displayName", mobileText(R.string.mobile_demo_model)).put("reasoningOptions", JSONArray()).put("serviceTiers", JSONArray()))
            ui.modelsLoading = false
        } else if (isNewTaskPage()) client?.takeIf { it.isConnected }?.let { refreshModelCatalog(it, force = true) }
        else refreshModelContext(refreshCatalog = true)
        modelEditProblem()?.let { modelReadError = it; return }
        if (localModelScope()) { quickSelection?.let(::applyModel); return }
        val current = owner.connection ?: return
        if (target == null) return
        work {
            try {
                val edit = target.bind(current.call(TaskModelTarget.READ, target.params()))
                onUi {
                    if (!isCurrent(owner) || modelPickerRequest != request || !ui.modelPickerOpen) return@onUi
                    modelPickerEdit = edit
                    quickSelection?.let(::applyModel)
                }
            } catch (error: Exception) { onUi {
                if (isCurrent(owner) && modelPickerRequest == request) modelReadError = MobileFailurePresentation.message(MobileOperationFailure.from(error))
            } }
        }
    }
    private fun applyModel(selection: JSONObject) {
        if (!ui.modelPickerOpen || !composer.isEnabled || modelWriting != null || modelEditProblem() != null) return
        val selected = ui.models.firstOrNull { it.optString("modelId") == selection.optString("modelId") && it.optString("providerId") == selection.optString("providerId") } ?: return
        val reasoning = selection.opt("reasoning") as? String
        val tier = selection.opt("serviceTier") as? String
        val options = selected.optJSONArray("reasoningOptions") ?: JSONArray()
        if (reasoning != null && (0 until options.length()).none { options.optString(it) == reasoning }) return
        if (tier != null && objects(selected.optJSONArray("serviceTiers") ?: JSONArray()).none { it.optString("id") == tier }) return
        val choice = MobileModelControls.parameters(selected, reasoning, tier)
        if (localModelScope()) {
            model = choice
            ui.modelPickerOpen = false
            persistInput(composer.text.toString())
            return
        }
        val edit = modelPickerEdit ?: return
        val owner = modelPickerOwner ?: return
        val current = owner.connection ?: return
        val intent = edit.intent(choice)
        modelWriting = owner
        ui.modelPickerOpen = false
        work {
            try {
                if (current.identity?.partition != owner.partition || !current.supports(TaskModelTarget.WRITE)) throw ProtocolFailure("NOT_CONNECTED")
                store.draft(owner.partition, owner.inputScope)?.let { if (store.hasPendingDraftCommand(it)) throw ProtocolFailure("COMMAND_RESULT_UNKNOWN") }
                val effect = JSONObject().put("kind", "taskModel").put("scope", owner.inputScope)
                val receipt = CommandOutbox(store).submit(current, TaskModelTarget.WRITE, intent, effect)
                val revision = edit.target.acceptedRevision(receipt)
                useConfirmedTaskModel(owner.partition, owner.inputScope)
                val taskId = edit.target.conversation.conversationId
                val updated = current.call("conversations.get", JSONObject().put("conversationId", taskId))
                if (updated.optString("id") != taskId || updated.getString("revision").toLong() < revision) throw ProtocolFailure("SOURCE_CHANGED")
                onUi {
                    if (isCurrent(owner)) {
                        acceptTaskProjection(updated)
                        refreshModelContext()
                    }
                }
            } finally { onUi { if (modelWriting == owner) modelWriting = null; refreshPendingOperations() } }
        }
    }
    private fun prepareNewTaskEntry(retry: Boolean) {
        val owner = operationOwner()
        currentEntry?.let { if (!retry || it.readingDefaults) return }
        val current = owner.connection?.takeIf { !demo && it.isConnected && it.identity?.partition == partition }
        val entry = NewTaskEntry(owner, readingDefaults = current != null)
        newTaskEntry = entry
        if (current != null) work {
            val result = runCatching { NewTaskDefaults.read(current) }
            onUi {
                if (newTaskEntry !== entry) return@onUi
                entry.defaults = result.getOrNull()
                entry.failed = result.isFailure
                entry.readingDefaults = false
            }
        }
    }
    private fun renderExecution() {
        val config = executionConfig
        if (ui.executionSelection.toString() != (config?.toString() ?: "{}")) ui.executionSelection = config ?: JSONObject()
        ui.executionLabel = config?.let(ExecutionSettings::label) ?: mobileText(R.string.permissions_not_selected)
        ui.executionEnabled = composer.isEnabled && !changingExecution && !ui.viewingArchived && (conversationTarget == null || ui.conversationReady)
    }
    private fun chooseExecution(selection: JSONObject? = null) {
        if (selection == null) {
            executionPickerOwner = partition; executionPickerScope = scope; hideKeyboard(); ui.executionPickerOpen = true; return
        }
        if (!ui.executionEnabled || executionPickerOwner != partition || executionPickerScope != scope) return
        val owner = partition
        val target = scope
        val task = selectedTask?.let { JSONObject(it.toString()) }
        fun apply(mode: ExecutionMode) {
            if (partition != owner || scope != target || !composer.isEnabled) return
            val config = mode.config()
            if (task == null || demo) {
                savedExecution = config
                renderExecution()
                persistInput(composer.text.toString())
                return
            }
            changingExecution = true
            renderExecution()
            work {
                try {
                    val targetClient = connected()
                    if (targetClient.identity?.partition != owner) throw ProtocolFailure("DATA_GENERATION_CHANGED")
                    val intent = JSONObject(config.toString()).put("conversationId", task.getString("id")).put("expectedRevision", task.getString("revision"))
                    requireAccepted(CommandOutbox(store).submit(targetClient, "conversations.setPermissionSettings", intent))
                    val updated = targetClient.call("conversations.get", JSONObject().put("conversationId", task.getString("id")))
                    val acceptedConfig = ExecutionSettings.resolve(null, updated)
                    onUi {
                        if (partition == owner && scope == target) {
                            acceptTaskProjection(updated)
                            savedExecution = ExecutionSettings.resolve(null, selectedTask)
                            renderExecution()
                            persistInput(composer.text.toString())
                            ui.notice = mobileText(R.string.mobile_the_service_updated_this_task_s_execution_mode)
                        } else disk.execute {
                            store.updateExecutionConfig(owner, target, acceptedConfig)
                        }
                    }
                } finally { onUi { changingExecution = false; renderExecution() } }
            }
        }
        val mode = ExecutionSettings.modes.firstOrNull { it.matches(selection) } ?: return
        ui.executionPickerOpen = false
        apply(mode)
    }

    private fun showConnection() = work {
        val current = connection.description()
        val hasSaved = connection.hasSavedIdentity()
        onUi {
            val dialog = AlertDialog.Builder(this).setTitle(mobileText(R.string.label_current_service)).setMessage(if (current == null) mobileText(R.string.mobile_pairing_incomplete_scan_the_service_s_pairing_qr_code) else mobileText(R.string.mobile_address, current.getString("endpoint"), if (client?.isConnected != true) mobileText(R.string.mobile_currently_disconnected) else mobileText(R.string.mobile_authenticated_connection_established))).setNegativeButton(mobileText(R.string.review_close), null)
            if (current != null && client?.isConnected != true) {
                dialog.setPositiveButton(mobileText(R.string.label_scan_to_connect)) { _, _ -> handleAction(MobileAction.ScanDevice, null) }
            }
            if (hasSaved) dialog.setNeutralButton(if (current == null) mobileText(R.string.mobile_cancel_pairing) else mobileText(R.string.mobile_unpair)) { _, _ -> leavePairing(current) }
            dialog.show()
        }
    }
    private fun leavePairing(expected: JSONObject?) {
        val actions = if (expected == null) arrayOf(mobileText(R.string.mobile_remove_incomplete_pairing)) else arrayOf(mobileText(R.string.mobile_revoke_service_access_and_unpair), mobileText(R.string.mobile_remove_phone_connection_only))
        AlertDialog.Builder(this).setTitle(mobileText(R.string.mobile_unpair_from_this_service)).setItems(actions) { _, index ->
            val revoke = expected != null && index == 0
            AlertDialog.Builder(this).setTitle(if (revoke) mobileText(R.string.mobile_revoke_access_and_unpair) else mobileText(R.string.mobile_remove_phone_connection_2))
                .setMessage(if (revoke) mobileText(R.string.mobile_this_revokes_this_phone_s_access_to_the_service) else mobileText(R.string.mobile_this_deletes_the_local_connection_credentials_and_keeps_local))
                .setPositiveButton(if (revoke) mobileText(R.string.mobile_revoke_and_unpair) else mobileText(R.string.mobile_remove_connection)) { _, _ ->
                    if (disconnecting) return@setPositiveButton
                    disconnecting = true
                    session.invalidate()
                    ui.notice = if (revoke) mobileText(R.string.mobile_revoking_service_access) else mobileText(R.string.mobile_removing_phone_connection)
                    work {
                        try {
                            val revoked = if (revoke) connection.logout(expected!!) else { connection.forget(expected); false }
                            onUi {
                                partition = "unpaired-local"; scope = "global"; selectedTask = null; activeTopic = "taskIndex"
                                navigation++; taskItems = emptyList(); messageItems = emptyList()
                                ui.tasksLoaded = false; ui.taskSyncFailed = false; ui.taskFilter = MobileTaskFilter.All; resetTaskMarks(); syncUi()
                                ui.screen = MobileScreen.Devices; refreshDevices(); restoreInput()
                                ui.connectionLabel = mobileText(R.string.mobile_no_service_connected_scan_a_qr_code_to_connect)
                                ui.notice = if (revoked) mobileText(R.string.mobile_service_access_revoked_local_inputs_remain_available_in_draft) else mobileText(R.string.mobile_phone_connection_removed_service_access_revocation_is_unconfirmed)
                            }
                        } finally { onUi { disconnecting = false } }
                    }
                }.setNegativeButton(mobileText(R.string.label_cancel), null).show()
        }.setNegativeButton(mobileText(R.string.label_cancel), null).show()
    }
    private fun showApprovals() {
        if (demo) { AlertDialog.Builder(this).setTitle(mobileText(R.string.mobile_review_operation)).setMessage(mobileText(R.string.mobile_source_demo_task_operation_read_an_authorized_directory_scope)).setPositiveButton(mobileText(R.string.mobile_allow_this_time)) { _, _ -> ui.notice = mobileText(R.string.mobile_demo_approval_completed) }.setNegativeButton(mobileText(R.string.review_deny)) { _, _ -> ui.notice = mobileText(R.string.mobile_demo_approval_denied) }.show(); return }
        conversationTarget?.let { operations.approvalsForTask(it.conversationId, it.branchId) } ?: operations.approvals()
    }
    private var messageMenuOwner = ""
    private var messageActionRequest = 0L
    private fun messageActions(message: JSONObject) = prepareMessageAction(message, null, contextual = true)
    private fun messageQuickAction(message: JSONObject, action: String) {
        val selected = when (action) {
            "edit" -> MobileAction.EditMessage
            "regenerate" -> MobileAction.RegenerateMessage
            "followup" -> MobileAction.ContinueMessage
            else -> return
        }
        prepareMessageAction(message, selected)
    }
    private fun prepareMessageAction(message: JSONObject, quick: MobileAction?, anchor: androidx.compose.ui.unit.IntRect? = null, contextual: Boolean = false) {
        hideKeyboard()
        val presentation = MobileMessagePresentation.message(message)
        val detail = MobileMessagePresentation.matchingDetail(message, details[presentation.id])
        val text = detail?.text ?: presentation.text
        val body = message.getJSONObject("body")
        val editable = body.optString("kind") == "user" && MobileContentAdapter.canEditAsText(body.getJSONObject("content"))
        val runId = message.opt("runId") as? String
        val owner = "$partition:$activeTopic"
        messageMenuOwner = owner
        val request = ++messageActionRequest
        val menu = MobileMessageMenu(message, text, text.isNotBlank() && MobileMessagePresentation.canCopy(text) && (!presentation.needsDetail || detail?.text != null), editable,
            presentation.needsDetail && detail?.text == null, loading = runId != null && !demo, anchor = anchor, contextual = contextual)
        fun deliver(value: MobileMessageMenu) {
            if (request != messageActionRequest || "$partition:$activeTopic" != owner) return
            if (quick == null) ui.messageMenu = value else applyMessageAction(quick, value)
        }
        ui.messageMenu = if (quick == null) menu else null
        if (quick == MobileAction.EditMessage) { deliver(menu); return }
        if (runId != null && !demo) {
            val current = client ?: return
            work {
                try {
                    val run = current.callValue("runs.get", JSONObject().put("runId", runId)) as? JSONObject
                    val execution = if (run != null && current.supports("runs.getExecutionState")) current.callValue("runs.getExecutionState", JSONObject().put("runId", runId)) as? JSONObject else null
                    onUi {
                        if (client === current && (quick != null || ui.messageMenu === menu)) deliver(menu.copy(run = run,
                            canRegenerate = run != null && run.optString("status") !in setOf("queued", "running") && (execution == null || execution.optString("resources") == "released"), loading = false))
                    }
                } catch (_: Exception) { onUi { if (request == messageActionRequest && "$partition:$activeTopic" == owner) { if (quick == null && ui.messageMenu === menu) ui.messageMenu = menu.copy(loading = false) else if (quick != null) ui.notice = mobileText(R.string.mobile_this_message_is_temporarily_unavailable_for_actions_please_retry) } } }
            }
        }
    }
    private fun performMessageAction(action: MobileAction) {
        val menu = ui.messageMenu ?: return
        ui.messageMenu = null
        if (messageMenuOwner != "$partition:$activeTopic") return
        applyMessageAction(action, menu)
    }
    private fun applyMessageAction(action: MobileAction, menu: MobileMessageMenu) {
        val message = menu.message
        when (action) {
            MobileAction.CopyMessage -> if (menu.canCopy) {
                (getSystemService(CLIPBOARD_SERVICE) as android.content.ClipboardManager).setPrimaryClip(ClipData.newPlainText("Lexora", menu.text))
                Toast.makeText(this, mobileText(R.string.copied), Toast.LENGTH_SHORT).show()
            }
            MobileAction.OpenMessageDetail -> loadMessageDetail(message)
            MobileAction.EditMessage -> if (menu.canEdit) selectedTask?.let { beginHistoryInput(JSONObject(it.toString()), message, HistorySource.Kind.Edit) }
            MobileAction.ContinueMessage -> if (menu.run?.optString("status") == "completed") selectedTask?.let { beginHistoryInput(JSONObject(it.toString()), message, HistorySource.Kind.Followup) }
            MobileAction.RegenerateMessage -> if (menu.canRegenerate) menu.run?.let { operations.command("chat.regenerateAssistant", JSONObject().put("conversationId", it.getString("conversationId")).put("sourceRunId", it.getString("id"))) }
            MobileAction.ShowMessageRun -> menu.run?.let { operations.showRun(it.getString("id")) }
            else -> Unit
        }
    }
    private fun beginHistoryInput(task: JSONObject, message: JSONObject, kind: HistorySource.Kind) {
        val owner = partition
        val source = ConversationTarget(task.getString("id"), message.getString("branchId")).history(message.getString("id"), kind)
        val target = source.localKey
        scope = target
        val value = JSONObject().put("content", if (kind == HistorySource.Kind.Followup) MobileContentAdapter.textContent("") else message.getJSONObject("body").getJSONObject("content").getJSONObject("content"))
            .put("modelSelection", task.opt("modelSelection") ?: JSONObject.NULL).put("executionConfig", ExecutionSettings.resolve(null, task))
        disk.execute {
            try { if (kind == HistorySource.Kind.Edit && store.draft(owner, target) == null) store.edit(owner, target, value) }
            catch (_: Exception) { onUi { if (partition == owner && scope == target) ui.notice = mobileText(R.string.mobile_previous_input_could_not_be_saved_select_its_source) } }
        }
        restoreInput()
    }
    private fun openOnDesktop() {
        val intent = JSONObject().put("kind", "tasks")
        selectedTask?.let { intent.put("conversationId", it.getString("id")) }
        val current = client ?: return
        val owner = operationOwner()
        work {
            val receipt = CommandOutbox(store).submit(current, "desktop.open", intent)
            requireAccepted(receipt)
            val result = receipt.getJSONObject("result").getJSONObject("desktop")
            onUi { if (!isCurrent(owner)) return@onUi; ui.notice = if (result.getBoolean("targetVisible") && result.getBoolean("visible")) mobileText(R.string.mobile_the_service_opened_the_requested_page) else mobileText(R.string.mobile_the_service_received_the_request_the_requested_page_is) }
        }
    }
    private fun moreHistory(cursor: String? = ui.historyCursor) {
        val target = conversationTarget ?: return
        val current = client?.takeIf { it.isConnected } ?: return
        if (ui.historyLoading || !ui.historyHasMore) return
        val context = liveContext(); val visit = navigation; val request = ++historyRequest
        val pinned = ui.historyPinned
        ui.historyLoading = true; ui.historyError = ""
        work {
            try {
                val result = current.call("conversations.listMessages", target.params().put("limit", 100).put("cursor", cursor ?: JSONObject.NULL))
                val messages = visibleMessages(objects(result.getJSONArray("items")))
                onUi {
                    if (context != liveContext() || visit != navigation || historyRequest != request || pinned != ui.historyPinned) return@onUi
                    historicalMessages = mergeMessages(messages, historicalMessages)
                    messageItems = if (pinned) historicalMessages else mergeMessages(historicalMessages, liveMessages)
                    ui.historyCursor = result.opt("nextCursor") as? String
                    ui.historyHasMore = ui.historyCursor != null; ui.historyLoading = false
                    renderRows()
                }
            } catch (error: Exception) { onUi { if (context == liveContext() && visit == navigation && historyRequest == request) { ui.historyLoading = false; ui.historyError = MobileFailurePresentation.message(MobileOperationFailure.from(error)) } } }
        }
    }
    private fun mergeMessages(older: List<JSONObject>, recent: List<JSONObject>): List<JSONObject> = (older + recent).associateBy { it.getString("id") }.values.sortedWith(compareBy<JSONObject> { it.optString("createdAt") }.thenBy { it.getString("id") })
    private fun visibleMessages(messages: List<JSONObject>) = messages.filter { message ->
        val body = message.getJSONObject("body")
        message.optString("role") != "assistant" || body.optString("kind") != "text" || body.optString("text").isNotBlank() || body.optBoolean("interrupted") || body.optBoolean("truncated") || message.optJSONArray("resources")?.length() != 0
    }
    private fun messageText(message: JSONObject): String {
        val body = message.getJSONObject("body")
        val author = when (message.getString("role")) { "user" -> mobileText(R.string.mobile_me); "assistant" -> "Lexora"; else -> mobileText(R.string.review_tool) }
        val text = if (body.optString("kind") == "user") MobileContentAdapter.text(body.getJSONObject("content")) else body.optString("text", body.optString("previewText"))
        val resources = message.optJSONArray("resources") ?: JSONArray()
        val content = if (text.isNotBlank()) text else if (resources.length() > 0) (0 until resources.length()).joinToString("\n") { mobileText(R.string.mobile_attachment_3, resources.getJSONObject(it).optString("name", mobileText(R.string.file_label))) } else ""
        val notice = when {
            body.optBoolean("interrupted") -> mobileText(R.string.mobile_this_reply_did_not_complete_check_the_run_result)
            body.optBoolean("truncated") || body.optString("kind") == "resource" -> if (message.optString("role") == "tool") mobileText(R.string.mobile_tap_to_view_full_content) else mobileText(R.string.mobile_tap_to_view_the_full_reply)
            else -> ""
        }
        return "$author\n${(content + notice).trim()}"
    }
    private fun localWork(operation: () -> Unit) {
        val owner = operationOwner()
        disk.execute {
            try { operation() }
            catch (error: Exception) { onUi { if (isCurrent(owner)) showNotice(MobileFailurePresentation.message(MobileOperationFailure.from(error))) } }
        }
    }
    private fun recoveryAttachmentLookup(): (LocalDraft) -> String? {
        val partitions = mutableMapOf<String, Map<String, List<JSONObject>>>()
        return { draft ->
            val byInput = partitions.getOrPut(draft.partition) {
                transfers.list(draft.partition).filter { it.optString("kind") in setOf("upload", "capture") &&
                    it.optString("state") in setOf("staged", "receiving", "captured") }
                    .groupBy { it.optString("inputId").takeIf(String::isNotEmpty)?.let { id -> "id:$id" } ?: "scope:${it.optString("scope")}" }
            }
            val records = byInput["id:${draft.value.optString("inputId")}"].orEmpty() + byInput["scope:${draft.scope}"].orEmpty()
            val ids = draft.value.optJSONObject("content")?.optJSONArray("panelResourceIds")
            val names = records.filterNot { row -> ids != null && (0 until ids.length()).any { ids.optString(it) == row.optString("resourceId") } }
            names.takeIf { it.isNotEmpty() }?.joinToString("\n") { row ->
                mobileText(R.string.recovery_pending_attachment, row.getJSONObject("file").getString("name"),
                    mobileText(if (row.optString("state") == "captured") R.string.mobile_photo_awaiting_attachment else R.string.mobile_upload_incomplete))
            }
        }
    }

    private fun reachableInputScopes(): Set<String> = buildSet {
        if (demo || ui.devices.any { it.selected }) {
            add(DraftContext.newTaskKey(null))
            ui.spaces.forEach { add(DraftContext.newTaskKey(it.getString("id"))) }
        }
        taskItems.forEach { task ->
            val id = task.optString("id")
            val branch = task.optString("activeBranchId")
            if (id.isNotBlank() && branch.isNotBlank()) add(ConversationTarget(id, branch).localKey)
        }
    }

    private fun inspectUnplacedInput() {
        val owner = partition
        val reachable = reachableInputScopes()
        val noDevice = !demo && ui.devices.none { it.selected }
        localWork {
            val available = recovery.hasUnplaced(owner, reachable)
            val downloads = noDevice && LocalFiles(this, transfers, store).hasRetainedDownload()
            onUi { if (partition == owner && ui.screen == MobileScreen.Tasks) {
                ui.hasUnplacedInput = available
                ui.hasOrphanDownloads = downloads
            } }
        }
    }

    private fun showRecovery() = recovery.local(reachableInputScopes())
    private fun resumeDraft(draft: LocalDraft, message: String) {
        if (partition != draft.partition) return
        clearConversationState()
        val target = DraftContext.target(draft.scope)
        val generation = ++navigation
        scope = draft.scope; navigate(MobileScreen.Conversation); selectedTask = null; messageItems = emptyList(); details = emptyMap(); syncUi()
        val conversationId = target.optString("conversationId").takeIf { it.isNotEmpty() }
        conversationTarget = DraftContext.conversation(draft.scope)
        restoreInput(); if (message.isEmpty()) ui.notice = "" else showNotice(message)
        subscription?.subscribe(activeTopic)
        val connection = client?.takeIf { it.isConnected && it.identity?.partition == draft.partition } ?: return
        if (conversationId != null) work {
            val task = connection.callValue("conversations.get", JSONObject().put("conversationId", conversationId)) as? JSONObject ?: throw ProtocolFailure("OBJECT_DELETED")
            onUi {
                if (generation == navigation && partition == draft.partition && scope == draft.scope) {
                    acceptTaskProjection(task)
                    refreshModelContext(); bindQuestions(); renderSpace()
                }
            }
        }
    }
    private fun showLocalFiles() = LocalFilesPanel(this, LocalFiles(this, transfers, store) { setOfNotNull(pendingCapturePath, pendingSave?.optString("path")) },
        ::work, ::onUi) { entry, action -> useFile(entry.file, entry.name, entry.mime, action) }.show(partition)

    private fun showFiles() {
        val options = mutableListOf(R.string.label_add_attachment, R.string.photo_attachment, R.string.upload_history, R.string.draft_attachments)
        if (selectedTask != null) options.add(R.string.label_task_files)
        options.add(R.string.local_files_storage)
        AlertDialog.Builder(this).setTitle(mobileText(R.string.file_label)).setItems(options.map { mobileText(it) }.toTypedArray()) { _, index -> when (index) {
            0 -> selectFile()
            1 -> capturePhoto()
            2 -> showTransfers()
            3 -> showDraftFiles()
            else -> if (options[index] == R.string.label_task_files) showTaskFiles(selectedTask!!.getString("id")) else showLocalFiles()
        } }.setNegativeButton(mobileText(R.string.review_close), null).show()
    }
    private fun captureFileTarget(): Boolean {
        if (!composer.isEnabled) { ui.notice = mobileText(R.string.mobile_this_input_contains_preserved_content_add_attachments_on_the); return false }
        if (composer.text.isEmpty() && (model != null || spaceId != null || ui.selectedSpaceId != null || executionConfig?.let { !ExecutionSettings.modes[2].matches(it) } == true)) persistInput(composer.text)
        input.flush()
        val target = DraftContext.scope(JSONObject().put("spaceId", spaceId ?: JSONObject.NULL), DraftContext.target(scope))
        pendingFileTarget = JSONObject().put("partition", partition).put("scope", scope).put("targetScope", target)
        return true
    }
    private fun selectFile() {
        if (!captureFileTarget()) return
        try { startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE), FILE_REQUEST) }
        catch (_: android.content.ActivityNotFoundException) { pendingFileTarget = null; ui.notice = mobileText(R.string.mobile_no_file_picker_available_your_input_is_retained) }
        catch (_: SecurityException) { pendingFileTarget = null; ui.notice = mobileText(R.string.mobile_could_not_open_the_file_picker_check_system_permissions) }
    }
    private fun capturePhoto() {
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.CAMERA), CAMERA_PERMISSION)
            return
        }
        if (!captureFileTarget()) return
        val target = JSONObject(pendingFileTarget!!.toString())
        work {
            val photos = PhotoStore(this, transfers)
            val record = synchronized(TransferStore.fileLock) {
                store.publishAttachment(target.getString("partition"), target.getString("scope"), null) { id -> photos.create(target.put("inputId", id)) }
            }
            val capture = photos.file(record)
            val uri = FileProvider.getUriForFile(this, "$packageName.files", capture)
            onUi {
                pendingFileTarget = record
                val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT, uri)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                intent.clipData = ClipData.newRawUri("Photo", uri)
                try { pendingCapturePath = capture.absolutePath; startActivityForResult(intent, CAMERA_REQUEST) }
                catch (_: android.content.ActivityNotFoundException) { pendingCapturePath = null; pendingFileTarget = null; work { photos.discard(record) }; ui.notice = mobileText(R.string.mobile_no_camera_app_available_choose_an_image_from_files) }
                catch (_: SecurityException) { pendingCapturePath = null; pendingFileTarget = null; work { photos.discard(record) }; ui.notice = mobileText(R.string.mobile_camera_permission_changed_grant_permission_again_or_choose_a) }
            }
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == CAMERA_PERMISSION) {
            if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) capturePhoto()
            else ui.notice = mobileText(R.string.mobile_camera_permission_not_granted_you_can_attach_a_file)
        }
    }
    override fun onSaveInstanceState(state: Bundle) {
        input.flush()
        state.putStringArrayList("screenHistory", ArrayList(screenHistory.map { it.name }))
        state.putString("screen", ui.screen.name)
        state.putString("selectedSpaceId", ui.selectedSpaceId)
        state.putString("selectedSpaceLabel", ui.selectedSpaceLabel)
        state.putString("taskFilter", ui.taskFilter.name)
        state.putString("fileTarget", pendingFileTarget?.toString())
        state.putString("capturePath", pendingCapturePath); state.putString("pendingSave", pendingSave?.toString())
        state.putString("pendingPreview", pendingPreview?.toString())
        state.putString("incomingMaterials", JSONArray(incomingMaterials.map { it.json() }).toString())
        state.putString("partition", partition); state.putString("scope", scope); state.putString("topic", activeTopic)
        state.putString("task", selectedTask?.toString())
        state.putBoolean("reconnectAllowed", session.reconnectAllowed)
        super.onSaveInstanceState(state)
    }
    @Deprecated("Android activity result compatibility")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        val scan = IntentIntegrator.parseActivityResult(requestCode, resultCode, data)
        if (scan != null) { scan.contents?.let { onPairingCode(it) }; return }
        if (requestCode == PREVIEW_REQUEST) {
            val target = pendingPreview; pendingPreview = null
            if (resultCode == RESULT_OK && target != null) continueFromPreview(target, data?.getStringExtra("quote").orEmpty())
            return
        }
        if (requestCode == SAVE_REQUEST) {
            val pending = pendingSave; pendingSave = null
            if (resultCode != RESULT_OK || data?.data == null) ui.notice = mobileText(R.string.mobile_save_cancelled_the_phone_copy_is_retained)
            if (resultCode == RESULT_OK && data?.data != null) {
                if (pending == null) { ui.notice = mobileText(R.string.mobile_save_source_not_found_save_again_from_the_phone); return }
                val uri = data.data!!
                work {
                    DocumentExport(this).save(File(pending.getString("path")), uri)
                    onUi { ui.notice = mobileText(R.string.file_saved) }
                }
            }
            return
        }
        if (requestCode != FILE_REQUEST && requestCode != CAMERA_REQUEST) return
        val target = pendingFileTarget
        pendingFileTarget = null
        val capture = if (requestCode == CAMERA_REQUEST) pendingCapturePath?.let { File(it) } else null
        if (requestCode == CAMERA_REQUEST) pendingCapturePath = null
        if (resultCode != RESULT_OK || target == null) { if (target?.optString("kind") == "capture") work { PhotoStore(this, transfers).discard(target) } else capture?.delete(); ui.notice = if (target == null && resultCode == RESULT_OK) mobileText(R.string.mobile_attachment_destination_not_found_select_it_again_your_input) else mobileText(R.string.mobile_attachment_cancelled_your_input_is_retained); return }
        val uri = capture?.let { FileProvider.getUriForFile(this, "$packageName.files", it) } ?: data?.data ?: run { ui.notice = mobileText(R.string.mobile_selected_file_unavailable_select_it_again); return }
        val persisted = disk.submit { }
        work {
            persisted.get()
            val transfer = if (target.optString("kind") == "capture") files.stageCapture(target) else files.stage(uri, target.getString("partition"), target.getString("scope"), target.getJSONObject("targetScope"))
            onUi { restoreInput(); saveFeedback(mobileText(R.string.mobile_uploading_attachment), false); uploadTransfer(transfer) }
        }
    }
    private fun uploadTransfer(original: JSONObject) = work {
        val current = connected()
        val owner = original.getString("partition")
        if (current.identity?.partition != owner) throw ProtocolFailure("DATA_GENERATION_CHANGED")
        val transfer = transfers.list(owner).first { it.getString("id") == original.getString("id") }
        val target = JSONObject().put("inputId", transfer.optString("inputId").takeIf { it.isNotEmpty() } ?: store.inputId(owner, transfer.getString("scope")))
        files.upload(current, transfer, target)
        onUi {
            if (partition == owner && ownsTransfer(transfer, store.draft(owner, scope))) {
                restoreInput()
                showNotice(mobileText(R.string.mobile_attachment_added))
            }
        }
    }
    private fun showTransfers() {
        val items = transfers.list(partition).filter { it.optString("kind") == "upload" || it.optString("kind") == "capture" && it.optString("state") == "captured" }
        items.filter { store.uploadSubmitted(it) }.forEach { it.put("state", "adopted"); transfers.save(it) }
        val states = mapOf("captured" to mobileText(R.string.mobile_photo_saved_on_phone_ready_to_attach), "staged" to mobileText(R.string.mobile_saved_on_phone_2), "receiving" to mobileText(R.string.mobile_upload_pending), "ready" to mobileText(R.string.mobile_attachment_ready), "adopted" to mobileText(R.string.mobile_submitted), "cancelled" to mobileText(R.string.mobile_cancelled))
        AlertDialog.Builder(this).setTitle(mobileText(R.string.upload_history)).setItems(items.map { "${it.getJSONObject("file").getString("name")} · ${states[it.optString("state")] ?: mobileText(R.string.mobile_unconfirmed)}" }.toTypedArray()) { _, index ->
            val transfer = items[index]
            val dialog = AlertDialog.Builder(this).setTitle(transfer.getJSONObject("file").getString("name")).setMessage(mobileText(R.string.mobile_this_file_still_belongs_to_the_draft_selected_when)).setNegativeButton(mobileText(R.string.review_close), null)
            if (transfer.optString("kind") == "capture") {
                dialog.setPositiveButton(mobileText(R.string.mobile_continue_adding_photo)) { _, _ -> work { val staged = files.stageCapture(transfer); onUi { uploadTransfer(staged) } } }
                dialog.setNeutralButton(mobileText(R.string.mobile_delete_phone_photo)) { _, _ -> AlertDialog.Builder(this).setTitle(mobileText(R.string.mobile_delete_this_unuploaded_photo)).setMessage(mobileText(R.string.mobile_delete_the_app_s_saved_photo_your_input_is)).setNegativeButton(mobileText(R.string.mobile_keep), null).setPositiveButton(mobileText(R.string.review_delete)) { _, _ -> work { PhotoStore(this, transfers).discard(transfer); onUi { showTransfers() } } }.show() }
            } else if (transfer.optString("state") !in setOf("adopted", "cancelled")) {
                if (transfer.optString("state") == "ready" && !transfer.has("inputId")) dialog.setPositiveButton(mobileText(R.string.mobile_review_draft_and_attach)) { _, _ -> reviewTransfer(transfer) }
                else dialog.setPositiveButton(if (transfer.optString("state") == "ready") mobileText(R.string.mobile_refresh_attachment) else mobileText(R.string.mobile_resume_upload)) { _, _ -> uploadTransfer(transfer) }
                dialog.setNeutralButton(mobileText(R.string.mobile_cancel_upload)) { _, _ -> work { files.cancel(connected(), transfer); onUi { showTransfers() } } }
            }
            dialog.show()
        }.setNegativeButton(mobileText(R.string.review_close), null).show()
    }
    private fun reviewTransfer(transfer: JSONObject) = work {
        val current = connected()
        val reviewed = files.reviewAdoption(current, transfer)
        onUi {
            AlertDialog.Builder(this).setTitle(mobileText(R.string.mobile_add_attachment_to_the_original_draft))
                .setMessage(mobileText(R.string.mobile_content_currently_saved_on_the_service_only_will_be, MobileContentAdapter.text(reviewed.getJSONObject("content")), transfer.getJSONObject("file").getString("name")))
                .setNegativeButton(mobileText(R.string.mobile_keep_attachment), null).setPositiveButton(mobileText(R.string.mobile_attach_to_this_version)) { _, _ -> work {
                    if (client !== current) throw ProtocolFailure("REVIEW_CHANGED")
                    files.adoptReviewed(current, transfer, reviewed)
                    onUi { if (partition == transfer.getString("partition") && scope == transfer.getString("scope")) restoreInput(); showNotice(mobileText(R.string.mobile_attachment_added)) }
                } }.show()
        }
    }
    private fun showTaskFiles(conversationId: String) {
        val panel = MobileTaskFiles(store.newId(), conversationId)
        ui.taskFiles = panel
        loadTaskFiles(panel)
    }
    private fun loadTaskFiles(panel: MobileTaskFiles) {
        val owner = operationOwner()
        ui.taskFiles = panel.copy(loading = true, error = null)
        work {
            try {
                if (!isCurrent(owner)) throw ProtocolFailure("SOURCE_CHANGED")
                val current = owner.connection?.takeIf { it.isConnected && it.identity?.partition == owner.partition } ?: throw ProtocolFailure("NOT_CONNECTED")
                val result = current.call("resources.list", JSONObject().put("conversationId", panel.conversationId).put("cursor", panel.nextCursor ?: JSONObject.NULL))
                val items = (panel.items + objects(result.getJSONArray("items"))).distinctBy { it.getString("resourceId") }
                val local = taskFileCopies.confirmed(owner.partition, items)
                onUi {
                    val latest = ui.taskFiles
                    if (partition == owner.partition && latest?.id == panel.id) ui.taskFiles = if (!isCurrent(owner)) latest.copy(loading = false, error = mobileText(R.string.error_source_changed))
                    else latest.copy(items = items, loading = false, nextCursor = result.optString("nextCursor").takeUnless { it.isBlank() || it == "null" },
                        transfers = latest.transfers + local.associateWith { id -> (latest.transfers[id] ?: TaskFileTransferState()).copy(localCopy = true) })
                }
            } catch (error: Exception) {
                onUi { if (partition == owner.partition && ui.taskFiles?.id == panel.id) ui.taskFiles = ui.taskFiles?.copy(loading = false, error = MobileFailurePresentation.message(MobileOperationFailure.from(error))) }
            }
        }
    }
    private fun draftAttachments(draft: LocalDraft?): List<MobileAttachmentItem> {
        if (draft == null) return emptyList()
        val resources = draft.value.getJSONObject("content").optJSONArray("panelResourceIds") ?: JSONArray()
        val ids = (0 until resources.length()).map { resources.getString(it) }
        val records = transfers.list(draft.partition)
        val editable = !store.hasPendingDraftCommand(draft)
        val attached = ids.map { id ->
            val record = records.firstOrNull { it.optString("resourceId") == id }
            val file = record?.optJSONObject("file")
            MobileAttachmentItem(id, file?.optString("name")?.takeIf { it.isNotBlank() } ?: mobileText(R.string.mobile_file_attached), file?.optString("mimeType").orEmpty(), mobileText(R.string.mobile_ready), editable)
        }
        val unfinished = records.filter { ownsTransfer(it, draft) &&
            it.optString("kind") in setOf("upload", "capture") && it.optString("state") in setOf("staged", "receiving", "captured") && it.optString("resourceId") !in ids }
            .map { record -> val file = record.getJSONObject("file")
                MobileAttachmentItem("transfer:${record.getString("id")}", file.getString("name"), file.optString("mimeType"), if (record.optString("state") == "captured") mobileText(R.string.mobile_photo_awaiting_attachment) else mobileText(R.string.mobile_upload_incomplete), false)
            }
        return attached + unfinished
    }
    private fun ownsTransfer(record: JSONObject, draft: LocalDraft?): Boolean =
        draft != null && record.optString("partition") == draft.partition &&
            (record.optString("inputId").takeIf(String::isNotEmpty)?.let { it == draft.value.optString("inputId") }
                ?: (record.optString("scope") == draft.scope))

    private fun openAttachment(id: String) {
        val owner = partition; val targetScope = scope; val current = client
        if (id.startsWith("transfer:")) {
            val record = transfers.get(id.removePrefix("transfer:"))?.takeIf {
                it.optString("partition") == owner && ownsTransfer(it, store.draft(owner, targetScope))
            } ?: return
            AlertDialog.Builder(this).setTitle(record.getJSONObject("file").getString("name"))
                .setMessage(mobileText(R.string.mobile_this_file_is_saved_on_the_phone_and_will))
                .setPositiveButton(mobileText(R.string.incoming_retry)) { _, _ -> if (owner == partition && targetScope == scope) {
                    if (record.optString("kind") == "capture") work { val staged = files.stageCapture(record); onUi { uploadTransfer(staged) } }
                    else uploadTransfer(record)
                } }.setNegativeButton(mobileText(R.string.review_close), null).show()
            return
        }
        val record = transfers.list(owner).firstOrNull { it.optString("resourceId") == id && it.has("inputId") }
        if (record == null) { showDraftFiles(); return }
        work {
            if (current?.isConnected != true || current.identity?.partition != owner) throw ProtocolFailure("NOT_CONNECTED")
            val state = current.call("uploads.get", JSONObject().put("uploadId", record.getString("uploadId")))
            if (state.isNull("attachmentId")) throw ProtocolFailure("RESOURCE_UNAVAILABLE")
            val resource = JSONObject(record.getJSONObject("file").toString()).put("resourceId", "attachment:${state.getString("attachmentId")}").put("revision", state.getString("contentVersion"))
            onUi { if (owner == partition && targetScope == scope && client === current) resourceActions(resource) }
        }
    }
    private fun removeAttachment(id: String) {
        if (ui.attachments.none { it.id == id && it.canRemove }) return
        val owner = partition; val targetScope = scope
        val expectedInput = store.draft(owner, targetScope)?.value?.optString("inputId") ?: return
        input.flush()
        composer.isEnabled = false
        disk.execute {
            try {
                ComposerMemory(store, transfers).detach(owner, targetScope, expectedInput, id)
                onUi { if (partition == owner && scope == targetScope) { restoreInput(); showNotice(mobileText(R.string.mobile_removed_from_input_the_phone_file_is_retained)) } }
            } catch (_: Exception) { onUi { if (partition == owner && scope == targetScope) { restoreInput(); ui.notice = mobileText(R.string.mobile_attachment_operations_remain_unconfirmed_check_send_history_before_retrying) } } }
        }
    }
    private fun showDraftFiles() {
        val owner = partition
        val targetScope = scope
        val local = store.draft(owner, targetScope) ?: return
        val resourceIds = local.value.getJSONObject("content").getJSONArray("panelResourceIds")
        val ids = (0 until resourceIds.length()).map { resourceIds.getString(it) }.toSet()
        if (ids.isEmpty()) { ui.notice = mobileText(R.string.mobile_no_attachments_in_the_current_input); return }
        work {
            val current = connected()
            if (current.identity?.partition != owner) throw ProtocolFailure("DATA_GENERATION_CHANGED")
            val items = transfers.list(owner).filter { it.optString("resourceId") in ids && it.has("inputId") }.map { transfer ->
                val state = current.call("uploads.get", JSONObject().put("uploadId", transfer.getString("uploadId")))
                if (state.isNull("attachmentId")) throw ProtocolFailure("RESOURCE_UNAVAILABLE")
                JSONObject(transfer.getJSONObject("file").toString()).put("resourceId", "attachment:${state.getString("attachmentId")}").put("revision", state.getString("contentVersion"))
            }.toMutableList()
            local.value.optString("draftId").takeIf { it.isNotEmpty() }?.let { draftId ->
                val old = current.callValue("composerDrafts.get", JSONObject().put("draftId", draftId)) as? JSONObject
                old?.optJSONArray("resources")?.let { resources -> items.addAll(objects(resources).filter { it.optString("bindingId") in ids }) }
            }
            onUi { if (partition == owner && scope == targetScope) AlertDialog.Builder(this).setTitle(mobileText(R.string.mobile_current_input_attachments)).setItems(items.map { it.getString("name") }.toTypedArray()) { _, index -> resourceActions(items[index]) }.setNegativeButton(mobileText(R.string.review_close), null).show() }
        }
    }
    private fun openResource(resource: JSONObject) {
        if (PreviewPolicy.kind(resource.getString("name"), resource.optString("mimeType")) != null) downloadFile(resource, R.string.preview_action)
        else resourceActions(resource)
    }
    private fun resourceActions(resource: JSONObject) {
        val previewable = PreviewPolicy.kind(resource.getString("name"), resource.optString("mimeType")) != null
        val actions = if (previewable) arrayOf(R.string.preview_action, R.string.save_to_files, R.string.share_file_title, R.string.open_other_app) else arrayOf(R.string.save_to_files, R.string.share_file_title)
        AlertDialog.Builder(this).setTitle(resource.getString("name")).setItems(actions.map { mobileText(it) }.toTypedArray()) { _, index -> downloadFile(resource, actions[index]) }.setNegativeButton(mobileText(R.string.review_close), null).show()
    }
    private fun downloadFile(resource: JSONObject, action: Int) {
        val owner = operationOwner()
        val resourceId = resource.getString("resourceId")
        val request = "${owner.partition}:$resourceId:${resource.getString("revision")}"
        if (!downloadingResources.add(request)) return
        val panel = ui.taskFiles?.takeIf { it.items.any { item -> item.optString("resourceId") == resourceId } }
        if (panel != null) ui.taskFiles = panel.copy(transfers = panel.transfers + (resourceId to (panel.transfers[resourceId] ?: TaskFileTransferState()).copy(loading = true, error = null, retryAction = action)))
        var dismissed = false
        val progress = if (panel == null) AlertDialog.Builder(this).setTitle(resource.getString("name"))
            .setMessage(mobileText(R.string.file_preparing_copy)).setNegativeButton(mobileText(R.string.review_close)) { _, _ -> dismissed = true }
            .setOnCancelListener { dismissed = true }.show() else null
        val followup = if (selectedTask != null && composer.isEnabled) JSONObject().put("id", store.newId()).put("partition", partition).put("scope", scope) else null
        work {
            val result = runCatching {
                taskFileCopies.find(owner.partition, resource, retain = action != R.string.preview_action) ?: run {
                    if (!isCurrent(owner)) throw ProtocolFailure("SOURCE_CHANGED")
                    val target = owner.connection?.takeIf { it.isConnected && it.identity?.partition == owner.partition }
                        ?: throw ProtocolFailure("LOCAL_COPY_UNAVAILABLE")
                    files.download(target, resource, previewOnly = action == R.string.preview_action)
                }
            }
            onUi {
                downloadingResources.remove(request)
                progress?.dismiss()
                val failure = result.exceptionOrNull()?.let { MobileFailurePresentation.message(MobileOperationFailure.from(it)) }
                val latest = ui.taskFiles
                if (partition == owner.partition && panel != null && latest?.id == panel.id) ui.taskFiles = latest.copy(transfers = latest.transfers +
                    (resourceId to TaskFileTransferState(error = failure, localCopy = result.isSuccess, retryAction = action)))
                if (!isCurrent(owner) || dismissed || panel != null && ui.taskFiles?.id != panel.id) return@onUi
                result.fold({ file ->
                    useFile(file, resource.getString("name"), resource.optString("mimeType").takeUnless { it.isBlank() || it == "null" } ?: "application/octet-stream", action, followup)
                }, {
                    if (panel == null) AlertDialog.Builder(this).setTitle(resource.getString("name")).setMessage(failure)
                        .setNegativeButton(mobileText(R.string.review_close), null).setPositiveButton(mobileText(R.string.label_retry)) { _, _ -> if (isCurrent(owner)) downloadFile(resource, action) }.show()
                })
            }
        }
    }
    private fun useFile(file: File, name: String, mime: String, action: Int, followup: JSONObject? = null) {
        val uri = FileProvider.getUriForFile(this, "$packageName.files", file, name)
        when (action) {
            R.string.preview_action -> {
                val intent = Intent(this, PreviewActivity::class.java).putExtra("path", file.absolutePath).putExtra("name", name).putExtra("mime", mime)
                if (followup == null) startActivity(intent)
                else {
                    pendingPreview = JSONObject(followup.toString()).put("path", file.absolutePath).put("name", name).put("mime", mime)
                    startActivityForResult(intent.putExtra("canFollowup", true), PREVIEW_REQUEST)
                }
            }
            R.string.save_to_files -> {
                pendingSave = JSONObject().put("path", file.absolutePath)
                try { startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).setType(mime).addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_TITLE, name), SAVE_REQUEST) }
                catch (_: android.content.ActivityNotFoundException) { pendingSave = null; ui.notice = mobileText(R.string.mobile_no_file_saver_available_the_phone_copy_is_retained) }
                catch (_: SecurityException) { pendingSave = null; ui.notice = mobileText(R.string.mobile_could_not_open_the_save_location_the_phone_copy) }
            }
            else -> {
                val intent = if (action == R.string.open_other_app) Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime) else Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri)
                intent.clipData = ClipData.newRawUri(name, uri)
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                try { startActivity(Intent.createChooser(intent, mobileText(action))) }
                catch (_: android.content.ActivityNotFoundException) { ui.notice = mobileText(R.string.mobile_no_compatible_app_available_save_to_a_file_instead) }
                catch (_: SecurityException) { ui.notice = mobileText(R.string.mobile_could_not_grant_another_app_read_access_the_phone) }
            }
        }
    }
    private fun continueFromPreview(target: JSONObject, quote: String) {
        if (quote.length > 8000 || target.optString("partition") != partition) { showNotice(mobileText(R.string.preview_service_changed)); return }
        val owner = target.getString("partition")
        val destination = target.getString("scope")
        val id = target.getString("id")
        val file = runCatching { PreviewPolicy.exportedFile(File(filesDir, "exports"), target.getString("path")) }.getOrElse { showNotice(mobileText(R.string.preview_copy_missing)); return }
        val name = target.getString("name")
        val text = mobileText(R.string.file_followup_prompt, name) + if (quote.isBlank()) "\n" else "\n\n${mobileText(R.string.file_quote_prompt)}\n> ${quote.replace("\n", "\n> ")}\n\n${mobileText(R.string.file_revision_prompt)}\n"
        if (scope == destination) {
            input.flush()
            composer.isEnabled = false; ui.sendEnabled = false; ui.inputEnabled = false
        }
        val appended = disk.submit<LocalDraft> { MaterialDrafts.append(store, owner, destination, id, text) }
        work {
            try {
                val draft = appended.get()
                val uri = FileProvider.getUriForFile(this, "$packageName.files", file, name)
                val transfer = files.stageMaterial(uri, owner, destination, id, draft.value.getString("inputId"), name, target.getString("mime"))
                onUi {
                    if (partition == owner && scope == destination) { ui.taskFiles = null; composer.requestFocus() }
                    showNotice(mobileText(R.string.file_context_added))
                    if (client?.identity?.partition == owner) uploadTransfer(transfer)
                }
            } finally { onUi { if (partition == owner && scope == destination) restoreInput() } }
        }
    }
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        receiveMaterial(intent)
    }
    private fun receiveMaterial(intent: Intent) {
        try {
            val material = IncomingMaterial.read(intent, packageName) ?: return
            incomingMaterials.addLast(material)
            if (!ui.importingMaterial) ui.incomingMaterial = incomingMaterials.first()
            ui.materialError = ""
        } catch (error: Exception) { showNotice(mobileText((error as? IncomingMaterialFailure)?.messageResource ?: R.string.incoming_read_failed)) }
    }

    private fun dismissMaterial() {
        if (ui.importingMaterial) return
        incomingMaterials.removeFirstOrNull()
        ui.incomingMaterial = incomingMaterials.firstOrNull(); ui.materialError = ""
    }
    private fun chooseMaterialDestination(choice: String, task: JSONObject?) {
        val material = ui.incomingMaterial ?: return
        if (ui.importingMaterial) return
        if (choice == "connect") { ui.incomingMaterial = null; navigate(MobileScreen.Devices); refreshDevices(); return }
        if (choice != "retry") {
            input.flush()
            when (choice) {
                "new" -> newTask()
                "task" -> {
                    if (task == null || taskItems.none { it.optString("id") == task.optString("id") }) return
                    val branch = navigationStore.getString(branchPreference(partition, task.getString("id")), null) ?: task.getString("activeBranchId")
                    showTask(task, target = ConversationTarget(task.getString("id"), branch))
                }
                "current" -> if (!composer.isEnabled) return
                else -> return
            }
        }
        val selected = if (material.partition == null) material.copy(partition = partition, scope = scope) else material
        if (selected.partition != partition) { ui.materialError = mobileText(R.string.incoming_original_service); return }
        incomingMaterials.removeFirst(); incomingMaterials.addFirst(selected)
        ui.incomingMaterial = selected; ui.importingMaterial = true; ui.materialError = ""
        composer.isEnabled = false
        val owner = selected.partition!!; val destination = selected.scope!!
        val initialSpace = ui.selectedSpaceId?.takeIf { destination == DraftContext.newTaskKey(it) && it.isNotBlank() }
        val initialSpaceName = ui.spaces.firstOrNull { it.optString("id") == initialSpace }?.optString("name")
        work {
            try {
                val draft = disk.submit<LocalDraft> { MaterialDrafts.append(store, owner, destination, selected.id, selected.text, initialSpace, initialSpaceName) }.get()
                val staged = selected.uris.mapIndexed { index, uri -> files.stageMaterial(uri, owner, destination, "${selected.id}:$index", draft.value.getString("inputId")) }
                onUi {
                    incomingMaterials.removeAll { it.id == selected.id }
                    ui.importingMaterial = false; ui.incomingMaterial = incomingMaterials.firstOrNull()
                    if (partition == owner && scope == destination) restoreInput()
                    showNotice(mobileText(R.string.incoming_saved))
                    if (client?.identity?.partition == owner) staged.forEach(::uploadTransfer)
                }
            } catch (error: Exception) {
                onUi {
                    ui.importingMaterial = false
                    ui.materialError = mobileText(R.string.incoming_partial, (MobileFailurePresentation.message(MobileOperationFailure.from(error))))
                    if (partition == owner && scope == destination) restoreInput()
                }
            }
        }
        syncUi()
    }
    private fun onPairingCode(value: String) {
        if (disconnecting) return
        rememberNavigation()
        val previous = connection.activeDeviceId()
        val generation = session.invalidate()
        ui.connectionLabel = mobileText(R.string.mobile_verifying_service_identity)
        ui.pairingPhase = "verifying"; ui.pairingError = ""
        work {
            try {
                connection.pair(value)
                onUi { if (generation == connectionGeneration) { if (ui.pairingPhase != null) ui.pairingPhase = "syncing"; ui.notice = ""; refreshDevices(); resumeConnection() } }
            } catch (failure: Exception) {
                onUi {
                    if (generation == connectionGeneration) {
                        if (ui.pairingPhase != null) { ui.pairingPhase = "failed"; ui.pairingError = MobileFailurePresentation.message(MobileOperationFailure.from(failure)) }
                        refreshDevices()
                        if (previous != null && previous == connection.activeDeviceId()) {
                            ui.connectionLabel = mobileText(R.string.mobile_pairing_incomplete_restoring_the_previous_service_connection)
                            resumeConnection()
                        } else ui.connectionLabel = mobileText(R.string.connection_not_connected)
                    }
                }
                throw failure
            }
        }
    }
    private fun loadFixture() {
        taskItems = (1..1000).map { JSONObject().put("id", "task-$it").put("activeBranchId", "branch-$it").put("title", mobileText(R.string.mobile_task_input_and_recovery, it)) }
        ui.tasksLoaded = true
        ui.markedTaskIds = emptySet(); ui.marksLoaded = true; ui.marksFailed = false
        if (selectedTask != null) messageItems = fixtureMessages()
        renderRows(); ui.notice = ""
    }
    private fun streamFixture() { var count = 0; val update = object : Runnable { override fun run() { if (destroyed || count++ >= 100) return; ui.notice = mobileText(R.string.mobile_demo_streaming_frame, count); streamHandler.postDelayed(this, 50) } }; streamHandler.post(update) }
    private fun connected(): ProductClient = client ?: throw ProtocolFailure("NOT_CONNECTED")
    private fun requireAccepted(receipt: JSONObject) { CommandReceipt.requireAccepted(receipt) }
    private fun operationOwner() = MobileOperationOwner(partition, activeTopic, scope, navigation, if (::session.isInitialized) connectionGeneration else -1, if (::session.isInitialized) client else null, ui.screen.name)
    private fun isCurrent(owner: MobileOperationOwner) = !destroyed && operationOwner() == owner
    private val operationRunner by lazy {
        MobileOperations(network, ::operationOwner, { runOnUiThread(it) }, { !destroyed }) { failure ->
            ui.notice = MobileFailurePresentation.message(failure)
            syncUi()
        }
    }
    private fun work(operation: () -> Unit) = operationRunner.execute(operation)
    private fun onUi(operation: () -> Unit) { runOnUiThread { if (!destroyed) { operation(); syncUi() } } }
    private fun saveFeedback(message: String, transient: Boolean = true) {
        saveFeedbackClear?.let { streamHandler.removeCallbacks(it) }
        ui.inputFeedback = message
        saveFeedbackClear = if (transient && message.isNotEmpty()) Runnable { ui.inputFeedback = "" }.also { streamHandler.postDelayed(it, 2500) } else null
    }
    private fun showNotice(message: String) {
        ui.notice = message
        streamHandler.postDelayed({ if (!destroyed && ui.notice == message) ui.notice = "" }, 3000)
    }
    private fun objects(array: JSONArray) = (0 until array.length()).map { array.getJSONObject(it) }
    private fun dp(value: Int) = (resources.displayMetrics.density * value).toInt()
    override fun onStart() { super.onStart(); session.start(!demo) }
    override fun onStop() { input.flush(); readerBenchmark?.close(); readModel.flush(); rememberNavigation(); super.onStop(); ui.connected = false; session.stop() }
    override fun onDestroy() { destroyed = true; input.close(); readerBenchmark?.close(); runTranscripts.close(); session.close(); streamHandler.removeCallbacksAndMessages(null); network.execute { disk.execute { store.close(); transfers.close() } }; network.shutdown(); readModel.close(); super.onDestroy() }
    companion object { private val disk = Executors.newSingleThreadExecutor(); const val INPUT_ID = 0x2101; const val EXECUTION_ID = 0x2102; const val SPACE_ID = 0x2103; const val SEND_ID = 0x2104; const val HISTORY_ID = 0x2105; const val FILE_REQUEST = 4001; const val CAMERA_REQUEST = 4002; const val PREVIEW_REQUEST = 4005; const val SAVE_REQUEST = 4003; const val CAMERA_PERMISSION = 4004 }
}
