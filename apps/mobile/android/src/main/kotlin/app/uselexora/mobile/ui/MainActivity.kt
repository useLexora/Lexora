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
import app.uselexora.mobile.protocol.MobileMessageDetail
import app.uselexora.mobile.storage.LocalDraft
import app.uselexora.mobile.protocol.CommandOutbox
import app.uselexora.mobile.protocol.CommandRecovery
import app.uselexora.mobile.protocol.CommandReceipt
import app.uselexora.mobile.protocol.ConversationTarget
import app.uselexora.mobile.protocol.HistorySource
import app.uselexora.mobile.protocol.MobileContentAdapter
import app.uselexora.mobile.protocol.MobileMessagePresentation
import app.uselexora.mobile.protocol.ProductIdentity
import app.uselexora.mobile.protocol.ProtocolFailure
import app.uselexora.mobile.protocol.ProtocolSchemas
import app.uselexora.mobile.storage.PhotoStore
import app.uselexora.mobile.storage.DocumentExport
import app.uselexora.mobile.storage.LocalFiles
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
    private lateinit var operations: TaskOperations
    private lateinit var recovery: DraftRecoveryPanel
    private lateinit var questions: MobileQuestions
    private var messageItems = listOf<JSONObject>()
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
    private var executionConfig = ExecutionSettings.defaultConfig()
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
        input = MobileComposerSession(store, disk, ::onUi)
        schemas = ProtocolSchemas(JSONObject(assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
        connection = MobileConnection(this, schemas, BuildConfig.VERSION_NAME)
        transfers = TransferStore(this)
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
            catalogChanged = { ui.models = it.items; ui.modelsLoading = it.loading; ui.modelsError = it.error },
            marksChanged = { ui.markedTaskIds = it.ids; ui.marksLoaded = it.loaded; ui.marksFailed = it.failed },
            cachedTasks = { ui.tasksLoaded = true; ui.taskSyncFailed = client?.isConnected != true },
            cachedConversation = { messages, branches ->
                branches?.let { if (ui.branches.isEmpty()) ui.branches = it }
                if (messages != null) { messageItems = visibleMessages(messages); ui.readingCached = true }
            })
        session = MobileConnectionSession(connection, schemas, getSystemService(ConnectivityManager::class.java), streamHandler,
            enabled = { !demo && !disconnecting }, topic = { activeTopic }, work = ::work, onUi = ::onUi,
            released = { operations.closeReview(); questions.close() },
            connected = { _, identity ->
                ui.connectionPhase = app.uselexora.mobile.session.MobileConnectionPhase.Idle
                if (partition != identity.partition) restoreNavigation(identity.partition)
                partition = identity.partition; restoreInput(); restoreCachedCatalogs(); refreshDevices(); refreshSpaces(); refreshPendingOperations(); ui.connectionLabel = mobileText(R.string.connection_loading_tasks)
                if (ui.notice == MobileFailurePresentation.NETWORK_UNAVAILABLE_NOTICE) ui.notice = ""
                subscription?.subscribe(activeTopic); bindQuestions(); if (selectedTask != null) loadBranches()
                if (activeTopic != "taskIndex") refreshTaskMarks()
                if (incomingMaterials.isNotEmpty() && !ui.importingMaterial) ui.incomingMaterial = incomingMaterials.first()
                syncUi()
            },
            status = { label, phase -> ui.connectionLabel = label; ui.connectionPhase = phase },
            failureMessage = { MobileFailurePresentation.message(MobileOperationFailure.from(it)) },
            synchronization = { state ->
                ui.connectionLabel = when (state) { "SYNCHRONIZED" -> mobileText(R.string.connection_connected); "SYNCING" -> mobileText(R.string.connection_loading_tasks); else -> mobileText(R.string.mobile_task_sync_interrupted_please_retry) }
                if (activeTopic == "taskIndex") ui.taskSyncFailed = state !in setOf("SYNCHRONIZED", "SYNCING")
            },
            projection = { topic, items -> readModel.committed(topic, items); ui.readingCached = false; renderProjection(topic, items); syncUi() },
            recoverable = { MobileOperationFailure.from(it).code == "SERVICE_UNREACHABLE" })
        demo = BuildConfig.PROBE_ENABLED && intent.getBooleanExtra("fixture", false)
        session.reconnectAllowed = state?.getBoolean("reconnectAllowed", true) ?: true
        val savedIdentity = runCatching { if (demo) null else connection.description() }
        partition = if (demo) "fixture:service:profile:generation:device" else savedIdentity.getOrNull()?.let { ProductIdentity.partition(it) } ?: "unpaired-local"
        val savedState = state?.takeIf { it.getString("partition") == partition }
        scope = savedState?.getString("scope") ?: "global"
        selectedTask = savedState?.getString("task")?.let { JSONObject(it) }
        conversationTarget = runCatching { ConversationTarget.fromTopic(savedState?.getString("topic") ?: "taskIndex") }.getOrNull()
        recovery = DraftRecoveryPanel(this, store, { partition }, ::work, ::onUi, ::resumeDraft)
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
            hint = mobileText(R.string.label_what_would_you_like_lexora_to_do)
            textSize = 16f; gravity = Gravity.TOP
            minLines = 1; maxLines = 6; setPadding(0, dp(10), 0, dp(10))
            background = null
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE or android.text.InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            imeOptions = android.view.inputmethod.EditorInfo.IME_ACTION_NONE or android.view.inputmethod.EditorInfo.IME_FLAG_NO_EXTRACT_UI or android.view.inputmethod.EditorInfo.IME_FLAG_NO_FULLSCREEN
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
                override fun afterTextChanged(s: Editable?) { if (!writingView) persistInput(s?.toString().orEmpty()); syncUi() }
            })
        }
        ui.connectionLabel = if (demo) mobileText(R.string.mobile_local_demo) else mobileText(R.string.mobile_not_connected)
        ui.screen = MobileScreen.Workbench
        refreshDevices()
        setContent {
            LexoraTheme {
                ui.incomingMaterial?.let { IncomingMaterialPanel(it, ui, ::chooseMaterialDestination, ::dismissMaterial) }
                MobileShell(ui, composer, ::handleAction) { modifier ->
                    WebMessageTimeline(ui.messages, ui.topic, modifier, details, ui.runs,
                        avatarContext = ReaderAvatarContext(partition, client?.takeIf { ui.connected }, schemas),
                        transcripts = transcriptRecords, onLoadTranscript = runTranscripts::request,
                        resultRunId = ui.resultRunId, onReadResult = ::readVisibleResult, onMessageAction = ::messageActions, onQuickAction = ::messageQuickAction, onResource = ::openResource, onLoadDetail = ::loadMessageDetail)
                }
            }
        }
        syncUi()
    }

    private fun handleAction(action: MobileAction, payload: JSONObject?) {
        when (action) {
            MobileAction.NewTask -> newTask()
            MobileAction.OpenTask -> payload?.let(::openTask)
            MobileAction.OpenTaskQuestions -> payload?.let { task -> openTaskAt(task) { it.optInt("pendingQuestionCount") > 0 } }
            MobileAction.OpenRunningTask -> payload?.let { task -> openTaskAt(task) { it.optInt("runningCount") > 0 } }
            MobileAction.OpenTaskResult -> payload?.let { task -> openTaskAt(task) { it.optString("id") == task.optString("resultBranchId") } }
            MobileAction.ShowTasks -> showTaskFilter(MobileTaskFilter.All)
            MobileAction.ShowTaskFilter -> MobileTaskFilter.entries.firstOrNull { it.name == payload?.optString("filter") }?.let(::showTaskFilter)
            MobileAction.ShowWorkbench -> { showRoot(MobileScreen.Workbench) }
            MobileAction.ShowSpaces -> { showRoot(MobileScreen.Spaces) }
            MobileAction.OpenSpace -> { ui.taskFilter = MobileTaskFilter.All; selectSpaceFilter(payload); navigate(MobileScreen.Tasks); refreshTasks() }
            MobileAction.ChooseSpaceFilter -> chooseSpaceFilter()
            MobileAction.Back -> goBack()
            MobileAction.ReviewTaskApproval -> payload?.optString("id")?.let { operations.approvalsForTask(it) }
            MobileAction.ShowPending -> showRoot(MobileScreen.Workbench)
            MobileAction.ShowDevices -> { navigate(MobileScreen.Devices); refreshDevices() }
            MobileAction.ScanDevice -> IntentIntegrator(this).setCaptureActivity(PairingCaptureActivity::class.java).setDesiredBarcodeFormats(IntentIntegrator.QR_CODE).setPrompt(mobileText(R.string.mobile_scan_the_pairing_qr_code_from_your_lexora_service)).setBeepEnabled(false).initiateScan()
            MobileAction.SelectDevice -> payload?.optString("id")?.let(::switchDevice)
            MobileAction.ManageDevice -> payload?.optString("id")?.let(::manageDevice)
            MobileAction.Approvals -> showApprovals()
            MobileAction.Outbox -> showOutbox()
            MobileAction.Recovery -> showRecovery()
            MobileAction.Files -> selectedTask?.let { showTaskFiles(it.getString("id")) } ?: showFiles()
            MobileAction.ManageFiles -> showFiles()
            MobileAction.OpenResource -> payload?.let(::openResource)
            MobileAction.ResourceActions -> payload?.let(::resourceActions)
            MobileAction.MoreFiles -> ui.taskFiles?.let { loadTaskFiles(it) }
            MobileAction.AttachFile -> selectFile()
            MobileAction.TakePhoto -> capturePhoto()
            MobileAction.ChooseModel -> chooseModel(true)
            MobileAction.ChooseReasoning -> chooseModel(false)
            MobileAction.ToggleFast -> {
                if (MobileModelControls.supportsFast(ui.modelSelection, ui.models)) ui.modelSelection?.let { selection ->
                    modelPickerOwner = partition; modelPickerTarget = scope
                    applyModel(JSONObject(selection.toString()).put("serviceTier", if (selection.optString("serviceTier") == "priority") JSONObject.NULL else "priority"))
                }
            }
            MobileAction.ApplyModel -> payload?.let(::applyModel)
            MobileAction.ApplyExecution -> payload?.let { chooseExecution(it) }
            MobileAction.ChooseExecution -> chooseExecution()
            MobileAction.ChooseSpace -> chooseSpace()
            MobileAction.Send -> send()
            MobileAction.MoreHistory -> moreHistory()
            MobileAction.Refresh -> {
                refreshSpaces()
                if (ui.screen == MobileScreen.Conversation && selectedTask != null) { refreshConversation(); refreshTaskMarks() }
                else refreshTasks()
            }
            MobileAction.Reconnect -> resumeConnection()
            MobileAction.TaskControls -> conversationTarget?.let(operations::runs)
            MobileAction.TaskQueue -> conversationTarget?.let(operations::queue)
            MobileAction.TaskBranches -> loadBranches()
            MobileAction.SelectBranch -> payload?.let(::selectBranch)
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
        ui.questionsSupported = client?.supports("questions.list") == true
        if (sortedTaskSource !== taskItems) { sortedTaskSource = taskItems; ui.tasks = taskItems.sortedByDescending { it.optString("updatedAt") } }
        if (displayedMessages !== messageItems) { displayedMessages = messageItems; ui.messages = messageItems }
        if (displayedTask !== selectedTask) { displayedTask = selectedTask; ui.selectedTask = selectedTask?.let { JSONObject(it.toString()) } }
        ui.viewBranchId = conversationTarget?.branchId
        ui.topic = "$partition:$activeTopic:$scope"
        runTranscripts.update("$partition:$activeTopic", client, ui.runs)
        ui.inputEnabled = composer.isEnabled
        ui.sendEnabled = composer.isEnabled && (composer.text.isNotBlank() || ui.attachmentCount > 0) && !input.isSubmitting && !ui.readingCached
        ui.hasInput = composer.text.isNotBlank() || ui.attachmentCount > 0
        val selection = model ?: inheritedModel.takeIf { modelContextKey == "$partition:$scope" }
        val resolvedModel = selection?.let { MobileModelControls.resolve(it, ui.models) }
        if (ui.modelSelection?.toString() != resolvedModel?.toString()) ui.modelSelection = resolvedModel
        if (ui.executionSelection.toString() != executionConfig.toString()) ui.executionSelection = JSONObject(executionConfig.toString())
        ui.modelLabel = MobileModelControls.model(ui.modelSelection, ui.models)?.optString("displayName")?.takeIf { it.isNotBlank() }
            ?: ui.modelSelection?.optString("modelId")?.takeIf { it.isNotBlank() } ?: if (ui.connected) mobileText(R.string.label_choose_model) else mobileText(R.string.label_disconnected)
        ui.executionLabel = ExecutionSettings.label(executionConfig)
        ui.spaceLabel = spaceName ?: mobileText(R.string.label_no_space)
        val taskSpace = selectedTask?.opt("spaceId") as? String
        ui.selectedTaskSpaceLabel = if (taskSpace == null) mobileText(R.string.label_no_space) else ui.spaces.firstOrNull { it.optString("id") == taskSpace }?.optString("name") ?: mobileText(R.string.mobile_space_temporarily_unavailable)
    }
    private fun navigate(screen: MobileScreen) {
        if (screen != ui.screen) { screenHistory.addLast(ui.screen); ui.screen = screen }
        if (screen != MobileScreen.Conversation) hideKeyboard()
    }
    private fun showRoot(screen: MobileScreen) {
        screenHistory.clear(); ui.screen = screen; hideKeyboard()
        refreshTasks(); refreshSpaces(); refreshPendingOperations()
    }
    private fun goBack() {
        hideKeyboard()
        ui.screen = screenHistory.removeLastOrNull() ?: MobileScreen.Workbench
        if (ui.screen in setOf(MobileScreen.Workbench, MobileScreen.Tasks, MobileScreen.Spaces)) { refreshTasks(); refreshPendingOperations() }
    }
    private fun showTaskFilter(filter: MobileTaskFilter) {
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
            selectSpaceFilter(values[index]); dialog.dismiss()
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
        ui.outboxCount = null
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
        val pending = input.pendingWrite
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
    private fun refreshPendingOperations() {
        val owner = partition
        disk.execute {
            val pending = store.outbox(owner).count { it.state !in setOf("accepted", "rejected") }
            onUi { if (partition == owner) ui.outboxCount = pending }
        }
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
                    presentation.readDetail(files.download(current, resolved), resolved, schemas, objects(message.optJSONArray("resources") ?: JSONArray()))
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
    private fun persistInput(text: String) {
        if (!composer.isEnabled) return
        saveFeedback("")
        val value = JSONObject().put("content", MobileContentAdapter.textContent(text)).put("modelSelection", model ?: JSONObject.NULL)
            .put("executionConfig", JSONObject(executionConfig.toString()))
            .put("spaceId", spaceId ?: JSONObject.NULL).put("spaceName", spaceName ?: JSONObject.NULL)
        input.persist(value, saved = { saveFeedback(mobileText(R.string.mobile_saved_on_phone)) }, failed = { saveFeedback(mobileText(R.string.mobile_save_failed_keep_this_input_open), false) })
    }
    private fun clearConversationState() {
        ui.taskFiles = null
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
        scope = "draft:${store.newId()}"; selectedTask = null; messageItems = emptyList(); activeTopic = "taskIndex"
        subscription?.subscribe(activeTopic)
        navigate(MobileScreen.Conversation)
        val owner = partition; val target = scope
        val selected = ui.selectedSpaceId?.takeIf { it.isNotBlank() }
        val name = ui.spaces.firstOrNull { it.optString("id") == selected }?.optString("name")
        disk.execute {
            store.edit(owner, target, JSONObject().put("content", MobileContentAdapter.textContent(""))
                .put("spaceId", selected ?: JSONObject.NULL).put("spaceName", name ?: JSONObject.NULL))
        }
        restoreInput(); syncUi(); ui.notice = ""
    }
    private fun restoreInput() {
        val target = scope
        val task = selectedTask?.let { JSONObject(it.toString()) }
        refreshModelContext()
        if (!input.displayingScope) {
            writingView = true; composer.setText(""); writingView = false
            composer.isEnabled = false; ui.sendEnabled = false; ui.inputEnabled = false; ui.executionEnabled = false; ui.spaceEnabled = false; model = null; ui.attachments = emptyList(); ui.attachmentCount = 0; saveFeedback(mobileText(R.string.mobile_opening_draft), false)
        }
        input.restore(::draftAttachments, ready = { current, attachments ->
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
            executionConfig = ExecutionSettings.resolve(current?.value, task)
            spaceId = DraftContext.spaceId(current?.value)
            spaceName = current?.value?.optString("spaceName")?.takeUnless { it.isEmpty() || it == "null" }
            renderSpace()
            renderExecution()
            when (HistorySource.fromScope(DraftContext.target(target))?.kind) {
                HistorySource.Kind.Followup -> ui.notice = mobileText(R.string.mobile_continuing_a_previous_reply_sending_creates_a_new_branch)
                HistorySource.Kind.Edit -> ui.notice = mobileText(R.string.mobile_editing_previous_input_sending_creates_a_new_branch)
                null -> Unit
            }

        }, failed = { saveFeedback(mobileText(R.string.mobile_could_not_open_the_draft_please_retry), false) })
    }
    private fun resumeConnection() = session.resume()
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
        clearConversationState()
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
        subscription?.let { it.subscribe(activeTopic); return }
        if (demo) { messageItems = fixtureMessages(); renderRows(); return }
        work {
            val result = connected().call("conversations.listMessages", target.params())
            val messages = visibleMessages(objects(result.getJSONArray("items")))
            onUi { if (generation != navigation) return@onUi; messageItems = messages; renderRows(); ui.notice = "" }
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
            messageItems = messages
            ui.runs = items.filter { it.optString("entity") == "run" }.map { it.getJSONObject("value") }
            ui.queueItems = items.filter { it.optString("entity") == "queue" }.map { it.getJSONObject("value") }
            ui.approvalItems = items.filter { it.optString("entity") == "approval" }.map { it.getJSONObject("value") }
            if (ui.runs.none { it.optString("id") == ui.stoppingRunId && it.optString("status") in setOf("queued", "running") }) ui.stoppingRunId = null
            items.firstOrNull { it.optString("entity") == "task" }?.getJSONObject("value")?.let {
                if (projectedTaskSource !== it) { projectedTaskSource = it; selectedTask = JSONObject(it.toString()) }
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
    private fun send(method: String = "chat.startTurn", extra: JSONObject = JSONObject()) {
        if (!composer.isEnabled) { ui.notice = mobileText(R.string.mobile_input_is_being_restored_or_requires_desktop_editing_the); return }
        if (demo) { val text = composer.text.toString(); if (text.isBlank()) return; input.pendingWrite?.get(); messageItems = messageItems + JSONObject().put("id", store.newId()).put("role", "user").put("body", JSONObject().put("kind", "text").put("text", text)); syncUi(); ui.notice = mobileText(R.string.mobile_demo_accepted_no_service_task_will_run); streamFixture(); return }
        val sendingClient = client ?: run { ui.notice = mobileText(R.string.mobile_no_service_connected_your_input_is_retained); return }
        input.submit(sendingClient, method, extra, ::work, accepted = { result ->
            if (partition == result.scope.partition && client === sendingClient) {
                if (result.method == "chat.queue.enqueue") showNotice(mobileText(R.string.mobile_added_to_the_send_queue)) else ui.notice = ""
                if (scope == result.scope.target) showTask(result.conversation, target = result.target)
            }
        }, settled = ::refreshPendingOperations)
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
    private fun showOutbox() {
        refreshPendingOperations()
        val owner = partition
        val current = client
        val items = store.outbox(owner)
        fun requireOwner(): ProductClient {
            if (partition != owner || client !== current) throw ProtocolFailure("SOURCE_CHANGED")
            return current?.takeIf { it.isConnected } ?: throw ProtocolFailure("NOT_CONNECTED")
        }
        AlertDialog.Builder(this).setTitle(mobileText(R.string.label_send_history)).setItems(items.map { "${commandLabel(it.method)} · ${commandState(it.state)}" }.toTypedArray()) { _, index -> work {
            val item = CommandOutbox(store).reconcile(requireOwner(), items[index])
            onUi {
                if (partition != owner || client !== current) return@onUi
                val recovery = CommandRecovery.forItem(item, current?.identity?.serviceInstanceId)
                val dialog = AlertDialog.Builder(this).setTitle("${commandLabel(item.method)} · ${commandState(item.state)}").setMessage(if (recovery == CommandRecovery.ReviewTask) mobileText(R.string.mobile_the_service_restarted_and_has_no_receipt_for_this) else when (item.state) {
                    "accepted" -> mobileText(R.string.mobile_the_service_received_this_operation_open_the_task_to)
                    "rejected" -> mobileText(R.string.mobile_this_operation_was_not_executed_your_input_is_retained)
                    "not_found" -> mobileText(R.string.mobile_the_service_has_not_found_this_operation_retrying_checks)
                    else -> mobileText(R.string.mobile_the_result_is_still_unknown_check_again_later_no)
                }).setNegativeButton(mobileText(R.string.review_close), null)
                if (recovery == CommandRecovery.ReviewApproval) dialog.setPositiveButton(mobileText(R.string.mobile_reload_approval)) { _, _ -> work { val review = requireOwner().call("approvals.get", JSONObject().put("approvalId", item.envelope.getJSONObject("intent").getString("approvalId"))); onUi { if (partition == owner && client === current) operations.review(review) } } }
                else if (recovery == CommandRecovery.RetryOriginal) dialog.setPositiveButton(mobileText(R.string.label_retry)) { _, _ -> work { CommandOutbox(store).retry(requireOwner(), item); onUi { if (partition == owner && client === current) { restoreInput(); showOutbox() } } } }
                dialog.show()
                restoreInput(); refreshPendingOperations()
            }
        } }.setNegativeButton(mobileText(R.string.review_close), null).show()
    }
    private fun commandLabel(method: String): String = when (method) {
        "chat.startTurn", "chat.submitInput" -> mobileText(R.string.mobile_send_task)
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
        "uploads.create", "uploads.complete", "uploads.adopt" -> mobileText(R.string.label_add_attachment)
        "uploads.cancel" -> mobileText(R.string.mobile_cancel_upload)
        "approvals.resolve" -> mobileText(R.string.mobile_handle_approval)
        "questions.answer" -> mobileText(R.string.mobile_answer_question)
        "questions.cancel" -> mobileText(R.string.mobile_skip_question)
        "questions.retry" -> mobileText(R.string.mobile_redeliver_answer)
        "conversations.activateBranch" -> mobileText(R.string.mobile_switch_history_branch)
        "desktop.open" -> mobileText(R.string.label_open_on_desktop)
        else -> mobileText(R.string.mobile_task_action)
    }
    private fun commandState(state: String): String = when (state) {
        "accepted" -> mobileText(R.string.mobile_received_by_service)
        "rejected" -> mobileText(R.string.mobile_not_executed)
        "prepared" -> mobileText(R.string.mobile_waiting_to_send)
        "not_found" -> mobileText(R.string.mobile_no_record_found)
        else -> mobileText(R.string.mobile_result_unconfirmed)
    }
    private var modelPickerOwner = ""
    private var modelPickerTarget = ""
    private var modelTaskRevision: String? = null
    private fun refreshModelContext(refreshCatalog: Boolean = false) {
        val current = client?.takeIf { it.isConnected } ?: return
        val owner = partition; val target = scope; val task = selectedTask
        val request = ++modelContextRequest
        modelTaskRevision = task?.optString("revision")
        if (modelContextKey != "$owner:$target") { inheritedModel = null; modelContextKey = "$owner:$target" }
        refreshModelCatalog(current, refreshCatalog)
        work {
            try {
                val selection = if (current.supports("providers.getInputSelection")) current.call("providers.getInputSelection", JSONObject().apply { task?.let { put("conversationId", it.getString("id")) } }).optJSONObject("modelSelection") else task?.optJSONObject("modelSelection")
                onUi {
                    if (client === current && partition == owner && scope == target && request == modelContextRequest) {
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
    private fun chooseModel(showList: Boolean = true) {
        hideKeyboard()
        ui.modelPickerShowList = showList
        modelPickerOwner = partition; modelPickerTarget = scope
        ui.modelPickerOpen = true
        if (demo) {
            if (ui.models.isEmpty()) ui.models = listOf(JSONObject().put("modelId", "demo").put("providerId", "demo").put("displayName", mobileText(R.string.mobile_demo_model)).put("reasoningOptions", JSONArray()).put("serviceTiers", JSONArray()))
            ui.modelsLoading = false
        } else refreshModelContext(refreshCatalog = true)
    }
    private fun applyModel(selection: JSONObject) {
        if (partition != modelPickerOwner || scope != modelPickerTarget || !composer.isEnabled) return
        val selected = ui.models.firstOrNull { it.optString("modelId") == selection.optString("modelId") && it.optString("providerId") == selection.optString("providerId") } ?: return
        val reasoning = selection.opt("reasoning") as? String
        val tier = selection.opt("serviceTier") as? String
        val options = selected.optJSONArray("reasoningOptions") ?: JSONArray()
        if (reasoning != null && (0 until options.length()).none { options.optString(it) == reasoning }) return
        if (tier != null && objects(selected.optJSONArray("serviceTiers") ?: JSONArray()).none { it.optString("id") == tier }) return
        model = JSONObject().put("modelId", selected.getString("modelId")).put("providerId", selected.getString("providerId"))
            .put("reasoning", reasoning ?: JSONObject.NULL).put("serviceTier", tier ?: JSONObject.NULL)
        ui.modelPickerOpen = false
        persistInput(composer.text.toString())
    }
    private fun renderExecution() {
        ui.executionLabel = ExecutionSettings.label(executionConfig)
        ui.executionEnabled = composer.isEnabled && !changingExecution
    }
    private fun chooseExecution(selection: JSONObject? = null) {
        if (selection == null) { hideKeyboard(); ui.executionPickerOpen = true; return }
        if (!composer.isEnabled || changingExecution) return
        val owner = partition
        val target = scope
        val task = selectedTask?.let { JSONObject(it.toString()) }
        val current = JSONObject(executionConfig.toString())
        fun apply(mode: ExecutionMode) {
            if (partition != owner || scope != target || !composer.isEnabled) return
            val config = mode.config()
            if (task == null || demo) {
                executionConfig = config
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
                            selectedTask = updated
                            executionConfig = acceptedConfig
                            renderExecution()
                            persistInput(composer.text.toString())
                            ui.notice = mobileText(R.string.mobile_the_service_updated_this_task_s_execution_mode)
                        } else disk.execute {
                            store.draft(owner, target)?.let { draft ->
                                store.edit(owner, target, JSONObject(draft.value.toString()).put("executionConfig", acceptedConfig))
                            }
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
            if (current != null) dialog.setPositiveButton(mobileText(R.string.mobile_update_service_address)) { _, _ ->
                val address = EditText(this).apply { inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_URI; setText(current.getString("endpoint")); selectAll() }
                AlertDialog.Builder(this).setTitle(mobileText(R.string.mobile_new_service_address)).setMessage(mobileText(R.string.mobile_enter_the_same_service_s_https_address_it_is)).setView(address).setPositiveButton(mobileText(R.string.mobile_verify_and_save)) { _, _ ->
                    val endpoint = address.text.toString()
                    work { connection.updateEndpoint(endpoint); onUi { session.invalidate(); ui.connectionLabel = mobileText(R.string.mobile_service_identity_verified_connecting_to_the_new_address); resumeConnection() } }
                }.setNegativeButton(mobileText(R.string.label_cancel), null).show()
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
    private fun messageActions(message: JSONObject) = prepareMessageAction(message, null)
    private fun messageQuickAction(message: JSONObject, action: String) {
        val selected = when (action) {
            "edit" -> MobileAction.EditMessage
            "regenerate" -> MobileAction.RegenerateMessage
            "followup" -> MobileAction.ContinueMessage
            else -> return
        }
        prepareMessageAction(message, selected)
    }
    private fun prepareMessageAction(message: JSONObject, quick: MobileAction?) {
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
            presentation.needsDetail && detail?.text == null, loading = runId != null && !demo)
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
            try { if (store.draft(owner, target) == null) store.edit(owner, target, value) }
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
    private fun moreHistory(cursor: String? = null) {
        val target = conversationTarget ?: return
        val current = client ?: return
        val owner = operationOwner()
        work {
            val params = target.params().put("cursor", cursor ?: JSONObject.NULL)
            val result = current.call("conversations.listMessages", params)
            val messages = objects(result.getJSONArray("items"))
            onUi { if (!isCurrent(owner)) return@onUi
                val title = mobileText(R.string.mobile_message_history)
                val dialog = AlertDialog.Builder(this).setTitle(title).setItems(messages.map { messageText(it) }.toTypedArray()) { _, index -> if (isCurrent(owner)) messageActions(messages[index]) }.setNegativeButton(mobileText(R.string.review_close), null)
                val next = result.optString("nextCursor").takeUnless { it.isEmpty() || it == "null" }
                if (next != null) dialog.setNeutralButton(mobileText(R.string.next_page)) { _, _ -> if (isCurrent(owner)) moreHistory(next) }
                dialog.show()
            }
        }
    }
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
    private fun showRecovery() { disk.execute { onUi { recovery.local() } } }
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
                    selectedTask = task
                    bindQuestions(); renderSpace()
                }
            }
        }
    }
    private fun showFiles() {
        val options = mutableListOf(R.string.label_add_attachment, R.string.photo_attachment, R.string.upload_history, R.string.draft_attachments)
        if (selectedTask != null) options.add(R.string.label_task_files)
        options.add(R.string.local_files_storage)
        AlertDialog.Builder(this).setTitle(mobileText(R.string.file_label)).setItems(options.map { mobileText(it) }.toTypedArray()) { _, index -> when (index) {
            0 -> selectFile()
            1 -> capturePhoto()
            2 -> showTransfers()
            3 -> showDraftFiles()
            else -> if (options[index] == R.string.label_task_files) showTaskFiles(selectedTask!!.getString("id")) else LocalFilesPanel(this, LocalFiles(this, transfers, store) { setOfNotNull(pendingCapturePath, pendingSave?.optString("path")) }, ::work, ::onUi) { entry, action -> useFile(entry.file, entry.name, entry.mime, action) }.show(partition)
        } }.setNegativeButton(mobileText(R.string.review_close), null).show()
    }
    private fun captureFileTarget(): Boolean {
        if (!composer.isEnabled) { ui.notice = mobileText(R.string.mobile_this_input_contains_preserved_content_add_attachments_on_the); return false }
        persistInput(composer.text.toString())
        val target = DraftContext.target(scope)
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
            val record = photos.create(target)
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
            if (partition == owner && scope == transfer.getString("scope")) restoreInput()
            showNotice(mobileText(R.string.mobile_attachment_added))
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
                val result = connected().call("resources.list", JSONObject().put("conversationId", panel.conversationId).put("cursor", panel.nextCursor ?: JSONObject.NULL))
                val items = (panel.items + objects(result.getJSONArray("items"))).distinctBy { it.getString("resourceId") }
                onUi { if (isCurrent(owner) && ui.taskFiles?.id == panel.id) ui.taskFiles = panel.copy(items = items, loading = false, nextCursor = result.optString("nextCursor").takeUnless { it.isBlank() || it == "null" }) }
            } catch (error: Exception) {
                onUi { if (isCurrent(owner) && ui.taskFiles?.id == panel.id) ui.taskFiles = panel.copy(loading = false, error = (MobileFailurePresentation.message(MobileOperationFailure.from(error)))) }
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
        val unfinished = records.filter { it.optString("scope") == draft.scope && it.optString("inputId") == draft.value.optString("inputId") &&
            it.optString("kind") in setOf("upload", "capture") && it.optString("state") in setOf("staged", "receiving", "captured") && it.optString("resourceId") !in ids }
            .map { record -> val file = record.getJSONObject("file")
                MobileAttachmentItem("transfer:${record.getString("id")}", file.getString("name"), file.optString("mimeType"), if (record.optString("state") == "captured") mobileText(R.string.mobile_photo_awaiting_attachment) else mobileText(R.string.mobile_upload_incomplete), false)
            }
        return attached + unfinished
    }
    private fun openAttachment(id: String) {
        val owner = partition; val targetScope = scope; val current = client
        if (id.startsWith("transfer:")) {
            val record = transfers.list(owner).firstOrNull { it.optString("id") == id.removePrefix("transfer:") && it.optString("scope") == targetScope } ?: return
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
        composer.isEnabled = false
        disk.execute {
            try {
                val draft = store.draft(owner, targetScope) ?: throw ProtocolFailure("EMPTY_DRAFT")
                if (expectedInput.isNotBlank() && draft.value.optString("inputId") != expectedInput) throw ProtocolFailure("DRAFT_CONFLICT")
                if (store.hasPendingDraftCommand(draft)) throw ProtocolFailure("LOCAL_FILE_IN_USE")
                val resources = draft.value.getJSONObject("content").getJSONArray("panelResourceIds")
                if ((0 until resources.length()).none { resources.getString(it) == id }) throw ProtocolFailure("SOURCE_CHANGED")
                store.detach(owner, store.inputId(owner, targetScope), id)
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
        val followup = if (selectedTask != null && composer.isEnabled) JSONObject().put("id", store.newId()).put("partition", partition).put("scope", scope) else null
        work {
            val target = connected()
            val file = files.download(target, resource)
            onUi {
                if (!isCurrent(owner)) return@onUi
                useFile(file, resource.getString("name"), resource.optString("mimeType").takeUnless { it.isBlank() || it == "null" } ?: "application/octet-stream", action, followup)
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
            persistInput(composer.text.toString())
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
            if (composer.isEnabled) persistInput(composer.text.toString())
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
        work {
            try {
                val draft = disk.submit<LocalDraft> { MaterialDrafts.append(store, owner, destination, selected.id, selected.text) }.get()
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
        work {
            try {
                connection.pair(value)
                onUi { if (generation == connectionGeneration) { ui.notice = mobileText(R.string.mobile_service_paired); refreshDevices(); resumeConnection() } }
            } catch (failure: Exception) {
                onUi {
                    if (generation == connectionGeneration) {
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
    override fun onStop() { readerBenchmark?.close(); readModel.flush(); rememberNavigation(); super.onStop(); ui.connected = false; session.stop() }
    override fun onDestroy() { destroyed = true; input.close(); readerBenchmark?.close(); runTranscripts.close(); session.close(); streamHandler.removeCallbacksAndMessages(null); network.execute { disk.execute { store.close(); transfers.close() } }; network.shutdown(); readModel.close(); super.onDestroy() }
    companion object { private val disk = Executors.newSingleThreadExecutor(); const val INPUT_ID = 0x2101; const val EXECUTION_ID = 0x2102; const val SPACE_ID = 0x2103; const val SEND_ID = 0x2104; const val HISTORY_ID = 0x2105; const val FILE_REQUEST = 4001; const val CAMERA_REQUEST = 4002; const val PREVIEW_REQUEST = 4005; const val SAVE_REQUEST = 4003; const val CAMERA_PERMISSION = 4004 }
}
