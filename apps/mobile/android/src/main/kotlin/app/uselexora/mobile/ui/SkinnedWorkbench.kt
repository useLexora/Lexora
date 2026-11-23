package app.uselexora.mobile.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.SubcomposeLayout
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.uselexora.mobile.R
import app.uselexora.mobile.i18n.mobileQuantity
import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.session.MobileConnectionPhase
import org.json.JSONObject
import kotlin.math.ceil
import kotlin.math.roundToInt

@Composable
internal fun currentSkinHome(): SkinHome? {
    val context = LocalContext.current
    val skinId = MobileAppearance.skinId
    val dark = LocalMobileDarkTheme.current
    return remember(context, skinId, dark) {
        val skin = BuiltinSkins.current(context)
        decodeSkinHome(skin.variant(dark).home, "skins/${skin.id}/")
    }
}

internal fun SkinInsets.paddingValues() = PaddingValues(start = left.dp, top = top.dp, end = right.dp, bottom = bottom.dp)

@Composable
private fun SkinSection(home: SkinHome, slot: String, modifier: Modifier = Modifier, content: @Composable BoxScope.() -> Unit) {
    val style = home.surfaces[slot]
    if (style == null) Box(modifier, content = content) else SkinSurface(style, modifier, content = content)
}

@Composable
internal fun SkinnedWorkbench(
    home: SkinHome,
    state: MobileUiState,
    tasks: List<JSONObject>,
    newTask: () -> Unit,
    filter: (MobileTaskFilter) -> Unit,
    devices: () -> Unit,
    settings: () -> Unit,
    act: (MobileAction) -> Unit,
) {
    fun count(value: MobileTaskFilter) = taskFilterCount(tasks, value, state.tasksLoaded, state.markedTaskIds, state.marksLoaded)
    WithSkinTypography(home.typography) {
        Box(Modifier.fillMaxSize()) {
            SkinSurface(home["background"], Modifier.matchParentSize())
            SkinWorkbenchPage(home, upper = {
                SkinWorkbenchHeader(home, state, devices, settings, act)
                SkinNewTask(home, newTask)
                SkinSection(home, "actions", Modifier.fillMaxWidth()) {
                    BoxWithConstraints(Modifier.fillMaxWidth().padding(home.layout.actionsPadding.paddingValues())) {
                        val pending: @Composable (Modifier) -> Unit = { cell ->
                            SkinPendingAction(home, "approvals", mobileText(R.string.label_approvals), SkinGlyph.Approval, count(MobileTaskFilter.Approvals), R.plurals.approval_tasks, cell) { filter(MobileTaskFilter.Approvals) }
                            SkinPendingAction(home, "questions", mobileText(R.string.question_answers), SkinGlyph.Question, count(MobileTaskFilter.Questions), R.plurals.question_tasks, cell) { filter(MobileTaskFilter.Questions) }
                        }
                        if (home.layout.stackActions(maxWidth.value, LocalDensity.current.fontScale)) {
                            Column(verticalArrangement = Arrangement.spacedBy(home.layout.actionsGap.dp)) { pending(Modifier.fillMaxWidth()) }
                        } else {
                            Row(horizontalArrangement = Arrangement.spacedBy(home.layout.actionsGap.dp)) { pending(Modifier.weight(1f)) }
                        }
                    }
                }
            }) {
                BoxWithConstraints(Modifier.widthIn(max = if (home.layout.centerShortcuts) 560.dp else androidx.compose.ui.unit.Dp.Infinity).fillMaxWidth().padding(home.layout.shortcutsPadding.paddingValues()), contentAlignment = Alignment.Center) {
                    val gap = home.layout.shortcutGap.dp
                    val minimum = home.layout.shortcutMinHeight.dp
                    val surplus = (minHeight - minimum * 3 - gap * 2).coerceAtLeast(0.dp)
                    val rowHeight = minimum + (surplus / 5).coerceAtMost(12.dp)
                    val rowGap = gap + (surplus / 10).coerceAtMost(8.dp)
                    Column(verticalArrangement = Arrangement.spacedBy(rowGap)) {
                        SkinShortcut(home, "unread", mobileText(R.string.label_unread), SkinGlyph.Unread, count(MobileTaskFilter.Unread), R.plurals.unread_tasks, "home-unread", rowHeight) { filter(MobileTaskFilter.Unread) }
                        SkinShortcut(home, "marked", mobileText(R.string.label_marked), SkinGlyph.Marked, count(MobileTaskFilter.Marked), R.plurals.marked_tasks, "home-marked", rowHeight) { filter(MobileTaskFilter.Marked) }
                        SkinShortcut(home, "all", mobileText(R.string.label_all), SkinGlyph.All, count(MobileTaskFilter.All), R.plurals.mobile_tasks, "home-all-tasks", rowHeight) { filter(MobileTaskFilter.All) }
                    }
                }
            }
        }
    }
}

@Composable
private fun SkinWorkbenchPage(home: SkinHome, upper: @Composable ColumnScope.() -> Unit, shortcuts: @Composable () -> Unit) {
    val page = home.layout
    Layout(
        modifier = Modifier.fillMaxSize().testTag("workbench-list").verticalScroll(rememberScrollState())
            .padding(start = page.pageInset.dp, end = page.pageInset.dp, top = page.pageTop.dp, bottom = page.pageBottom.dp),
        content = {
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(page.gap.dp), content = upper)
            Box(Modifier.fillMaxWidth().testTag("workbench-shortcut-bay"), contentAlignment = Alignment.Center, propagateMinConstraints = !page.centerShortcuts) {
                home.surfaces["shortcuts"]?.let { SkinSurface(it, Modifier.matchParentSize()) }
                shortcuts()
            }
            if (page.footerHeight > 0f) SkinSection(home, "footer", Modifier.fillMaxWidth().height(page.footerHeight.dp).testTag("workbench-footer")) {}
        },
    ) { children, constraints ->
        val natural = constraints.copy(minHeight = 0)
        val top = children[0].measure(natural)
        val footer = children.getOrNull(2)?.measure(natural)
        val gap = page.gap.dp.roundToPx()
        val reserved = top.height + gap + (footer?.let { it.height + gap } ?: 0)
        val bay = children[1].measure(natural.copy(minHeight = (constraints.minHeight - reserved).coerceAtLeast(0)))
        layout(top.width, reserved + bay.height) {
            top.place(0, 0)
            bay.place(0, top.height + gap)
            footer?.place(0, reserved + bay.height - footer.height)
        }
    }
}

@Composable
private fun SkinWorkbenchHeader(home: SkinHome, state: MobileUiState, devices: () -> Unit, settings: () -> Unit, act: (MobileAction) -> Unit) {
    val fonts = LocalSkinTypefaces.current
    val settingsLabel = mobileText(R.string.skin_home_settings)
    val settingsTextStyle = TextStyle(fontFamily = fonts.body, fontSize = 14.sp, fontWeight = FontWeight(home.typography.weight))
    val settingsLabelWidth = rememberTextMeasurer().measure(settingsLabel, settingsTextStyle, softWrap = false).size.width
    Column(Modifier.fillMaxWidth().testTag("service-status-bar")) {
        SkinSurface(home["header"], Modifier.fillMaxWidth().heightIn(min = home.layout.headerHeight.dp)) {
            BoxWithConstraints(Modifier.fillMaxWidth().align(Alignment.Center)) {
                val scale = (maxWidth.value / 390f).coerceAtMost(1f)
                val padding = home.layout.headerPadding.let { it.copy(left = it.left * scale, right = it.right * scale) }
                val settingsWidth = (home.layout.settingsWidth * scale).dp.coerceAtLeast(48.dp)
                val showSettingsLabel = home.layout.settingsLabel && with(LocalDensity.current) { settingsLabelWidth.toDp() + 41.dp <= settingsWidth }
                Row(Modifier.fillMaxWidth().padding(padding.paddingValues()), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Image(painterResource(R.mipmap.ic_lexora), null, Modifier.size(home.layout.brandIconSize.dp).clip(RoundedCornerShape((home.layout.brandIconSize * .28f).dp)).testTag("workbench-brand-icon"))
                    Text(mobileText(R.string.skin_home_brand), Modifier.weight(1f).testTag("workbench-brand-label"), fontFamily = fonts.brand,
                        fontSize = home.typography.brandSize.sp, lineHeight = (home.typography.brandSize * 1.15f).sp,
                        fontWeight = FontWeight(home.typography.brandWeight), fontStyle = if (home.typography.brandItalic) FontStyle.Italic else FontStyle.Normal,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                    SkinSurface(home["settings"], Modifier.width(settingsWidth).heightIn(min = 48.dp).testTag("workbench-settings")
                        .semantics { contentDescription = mobileText(R.string.mobile_phone_settings) }, settings) {
                        Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("workbench-settings-surface"), horizontalArrangement = Arrangement.spacedBy(5.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
                            SkinIcon(SkinGlyph.Settings, home.iconStyle, Modifier.size(24.dp))
                            if (showSettingsLabel) Text(settingsLabel, style = settingsTextStyle, maxLines = 1)
                        }
                    }
                }
            }
        }
        SkinSection(home, "connection", Modifier.fillMaxWidth()) {
            val padding = home.layout.connectionPadding
            BoxWithConstraints(Modifier.fillMaxWidth().padding(padding.paddingValues())) {
                val fontScale = LocalDensity.current.fontScale
                val stacked = home.layout.stackHeader(maxWidth.value, fontScale)
                val minimum = (home.layout.connectionMinHeight - padding.top - padding.bottom).coerceAtLeast(0f).dp
                val serviceWidth = maxWidth * if (fontScale > 1.2f) 1f else home.layout.serviceWidth
                val spaceWidth = maxWidth * if (fontScale > 1.2f) 1f else home.layout.spaceWidth
                if (stacked) {
                    Column(Modifier.fillMaxWidth().heightIn(min = minimum), verticalArrangement = Arrangement.spacedBy(home.layout.connectionGap.dp)) {
                        SkinServiceSelector(home, state, Modifier.width(serviceWidth), devices)
                        if (state.connected) SkinSpaceFilter(home, state, Modifier.width(spaceWidth)) { act(MobileAction.ChooseSpaceFilter) }
                    }
                } else {
                    val widths = home.layout.inlineWidths()
                    val available = (maxWidth - if (state.connected) home.layout.connectionGap.dp else 0.dp).coerceAtLeast(0.dp)
                    Row(Modifier.fillMaxWidth().heightIn(min = minimum), horizontalArrangement = Arrangement.spacedBy(home.layout.connectionGap.dp), verticalAlignment = Alignment.CenterVertically) {
                        SkinServiceSelector(home, state, Modifier.width(if (state.connected) available * widths.first else serviceWidth), devices)
                        if (state.connected) SkinSpaceFilter(home, state, Modifier.width(available * widths.second).align(when (home.layout.spaceVerticalAlignment) {
                            "bottom" -> Alignment.Bottom; "top" -> Alignment.Top; else -> Alignment.CenterVertically
                        })) { act(MobileAction.ChooseSpaceFilter) }
                    }
                }
            }
        }
        SkinConnectionStatus(home["service"], state, act)
    }
}

@Composable
private fun SkinConnectionStatus(style: SkinSurfaceStyle, state: MobileUiState, act: (MobileAction) -> Unit) {
    if (state.connected && !state.taskSyncFailed && state.tasksLoaded && !state.marksFailed) return
    SkinSurface(style, Modifier.fillMaxWidth()) {
        Box(Modifier.padding(horizontal = 14.dp, vertical = 4.dp)) {
            val color = Color(style.foreground)
            when {
                !state.connected -> {
                    val reconnecting = state.connectionPhase == MobileConnectionPhase.Connecting || state.connectionPhase == MobileConnectionPhase.Retrying
                    val message = if (reconnecting && state.tasksLoaded) mobileText(R.string.mobile_reconnecting_cached_tasks) else state.connectionLabel
                    val canReconnect = !reconnecting && state.devices.any { it.selected }
                    HomeStatus(message, if (canReconnect) mobileText(R.string.label_reconnect) else null, Modifier.testTag("connection-detail"), color) { act(MobileAction.Reconnect) }
                }
                state.taskSyncFailed -> HomeStatus(mobileText(R.string.mobile_task_update_failed), mobileText(R.string.label_retry), color = color) { act(MobileAction.Refresh) }
                !state.tasksLoaded -> HomeStatus(mobileText(R.string.label_syncing_tasks), color = color)
                state.marksFailed -> HomeStatus(mobileText(R.string.label_task_marks_could_not_sync_please_retry), mobileText(R.string.label_retry), color = color) { act(MobileAction.Refresh) }
            }
        }
    }
}

@Composable
private fun SkinServiceSelector(home: SkinHome, state: MobileUiState, modifier: Modifier, onClick: () -> Unit) {
    val style = home["service"]
    val fonts = LocalSkinTypefaces.current
    val compact = home.layout.serviceLayout == "compact"
    val status = when {
        state.connected -> MaterialTheme.colorScheme.secondary
        state.connectionPhase != MobileConnectionPhase.Idle -> MaterialTheme.colorScheme.tertiary
        else -> Color(style.muted)
    }
    SkinSurface(style, modifier.heightIn(min = home.layout.serviceHeight.dp).testTag("service-selector")
        .semantics { contentDescription = listOf(state.deviceLabel, state.connectionLabel).joinToString(" · ") }, onClick) {
        SkinContentRegion(home.layout.serviceContentBounds, home.layout.serviceHeight, Modifier.testTag("service-selector-surface")) {
            if (compact) {
                Row(Modifier.fillMaxWidth().testTag("service-selector-content"), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SkinIcon(SkinGlyph.Service, home.iconStyle, Modifier.size(20.dp), Color(style.icon))
                    Text(state.deviceLabel, Modifier.weight(1f), fontFamily = fonts.body, fontSize = home.typography.serviceSize.sp,
                        fontWeight = FontWeight(home.typography.weight), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Box(Modifier.size(7.dp).clip(CircleShape).background(status))
                    if (state.connected) Text(mobileText(R.string.label_connected), color = Color(style.muted), fontFamily = fonts.body, fontSize = home.typography.serviceSize.sp)
                }
            } else {
                Column(Modifier.fillMaxWidth().testTag("service-selector-content"), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Box(Modifier.size(8.dp).clip(CircleShape).background(status))
                        Text(state.deviceLabel, Modifier.testTag("service-host-label"), fontFamily = fonts.body, fontSize = home.typography.serviceSize.sp, lineHeight = (home.typography.serviceSize * 1.25f).sp,
                            fontWeight = FontWeight(home.typography.weight), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    Text(if (state.connected) mobileText(R.string.label_connected) else state.connectionLabel,
                        Modifier.padding(start = 20.dp).testTag("service-state-label"), color = Color(style.muted), fontFamily = fonts.body,
                        fontSize = (home.typography.serviceSize - 2).coerceAtLeast(12f).sp, lineHeight = (home.typography.serviceSize * 1.25f).sp)
                }
            }
        }
    }
}

@Composable
private fun SkinSpaceFilter(home: SkinHome, state: MobileUiState, modifier: Modifier, onClick: () -> Unit) {
    val label = if (state.selectedSpaceId == null) mobileText(R.string.label_all_spaces) else state.selectedSpaceLabel
    SkinSurface(home["space"], modifier.heightIn(min = home.layout.spaceHeight.dp).testTag("space-filter").semantics { contentDescription = label }, onClick) {
        SkinContentRegion(home.layout.spaceContentBounds, home.layout.spaceHeight, Modifier.testTag("space-filter-surface")) {
            Row(Modifier.fillMaxWidth().testTag("space-filter-content"), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(label, Modifier.weight(1f).testTag("space-filter-label"), fontFamily = LocalSkinTypefaces.current.body, fontWeight = FontWeight(home.typography.weight),
                    fontSize = home.typography.spaceSize.sp, lineHeight = (home.typography.spaceSize * 1.25f).sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                SkinIcon(SkinGlyph.Down, home.iconStyle, Modifier.size(18.dp).testTag("space-filter-arrow"))
            }
        }
    }
}

@Composable
private fun SkinContentRegion(region: SkinRegion, minimumHeight: Float, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    SubcomposeLayout(modifier.fillMaxWidth()) { constraints ->
        val width = constraints.maxWidth
        val child = subcompose("content", content).single().measure(Constraints.fixedWidth((width * region.width).roundToInt().coerceAtLeast(1)))
        val height = maxOf(minimumHeight.dp.roundToPx(), ceil(child.height / region.height).toInt())
        layout(width, height) {
            child.place((width * region.x).roundToInt(), (height * region.y + (height * region.height - child.height) / 2).roundToInt())
        }
    }
}

@Composable
internal fun SkinNewTask(home: SkinHome, onClick: (() -> Unit)? = null) {
    val centered = home.layout.heroAlignment == "centered"
    val bodyFont = LocalSkinTypefaces.current.body
    SkinSurface(home["hero"], Modifier.fillMaxWidth().testTag("new-task"), onClick) {
        SubcomposeLayout(Modifier.fillMaxWidth()) { constraints ->
            val width = constraints.maxWidth
            val promptRegion = home.layout.heroPromptBounds
            val actionRegion = home.layout.heroActionBounds
            val promptWidth = (width * promptRegion.width).roundToInt().coerceAtLeast(1)
            val actionWidth = (width * actionRegion.width).roundToInt().coerceAtLeast(1)
            val prompt = subcompose("prompt") {
                Text(mobileText(R.string.skin_home_prompt), color = Color(home["hero"].muted), fontFamily = bodyFont,
                    fontSize = home.typography.promptSize.sp, lineHeight = (home.typography.promptSize * 1.4f).sp, fontWeight = FontWeight(home.typography.weight),
                    fontStyle = if (home.typography.promptItalic) FontStyle.Italic else FontStyle.Normal)
            }.single().measure(Constraints(maxWidth = promptWidth))
            val action = subcompose("action") {
                SkinSurface(home["heroAction"], Modifier.fillMaxWidth()) {
                    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp, if (centered) Alignment.CenterHorizontally else Alignment.Start)) {
                        if (centered) SkinHeroIcon(home, SkinGlyph.Add)
                        SkinHeroTitle(home, Modifier.weight(1f, fill = !centered))
                        if (!centered) SkinHeroIcon(home, SkinGlyph.Arrow)
                    }
                }
            }.single().measure(Constraints.fixedWidth(actionWidth))
            val height = ceil(home.layout.heroHeight(prompt.height.toDp().value, action.height.toDp().value, width.toDp().value).dp.toPx()).toInt()
            layout(width, height) {
                prompt.place((width * promptRegion.x).roundToInt(), (height * promptRegion.y + (height * promptRegion.height - prompt.height) / 2).roundToInt())
                action.place((width * actionRegion.x).roundToInt(), (height * actionRegion.y + (height * actionRegion.height - action.height) / 2).roundToInt())
            }
        }
    }
}

@Composable
private fun SkinHeroTitle(home: SkinHome, modifier: Modifier) {
    val label = mobileText(R.string.label_new_task)
    val style = TextStyle(fontFamily = LocalSkinTypefaces.current.body, fontSize = home.typography.titleSize.sp, fontWeight = FontWeight(home.typography.titleWeight))
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    BoxWithConstraints(modifier) {
        val width = with(density) { (maxWidth - 1.dp).roundToPx().coerceAtLeast(1) }
        val fontSize = remember(label, style, width, density, measurer) {
            fun fits(size: Float): Boolean = measurer.measure(label, style.copy(fontSize = size.sp, lineHeight = (size * 1.25f).sp),
                constraints = Constraints(maxWidth = width)).lineCount == 1
            if (fits(home.typography.titleSize)) home.typography.titleSize
            else {
                var minimum = minOf(26f, home.typography.titleSize)
                var maximum = home.typography.titleSize
                repeat(8) {
                    val candidate = (minimum + maximum) / 2
                    if (fits(candidate)) minimum = candidate else maximum = candidate
                }
                minimum
            }
        }
        Text(label, color = Color(home["heroAction"].foreground), style = style.copy(fontSize = fontSize.sp, lineHeight = (fontSize * 1.25f).sp))
    }
}

@Composable
private fun SkinHeroIcon(home: SkinHome, glyph: SkinGlyph) {
    SkinSurface(home["heroIcon"], Modifier.size(home.layout.heroIconSize.dp)) {
        SkinIcon(glyph, home.iconStyle, Modifier.size((home.layout.heroIconSize * if (glyph == SkinGlyph.Add) .86f else .8f).dp).align(Alignment.Center))
    }
}

@Composable
internal fun SkinCoverArt(home: SkinHome) {
    WithSkinTypography(home.typography) {
        SkinSurface(home["background"], Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxWidth()) {
                SkinSurface(home["header"], Modifier.fillMaxWidth().height(home.layout.headerHeight.dp)) {
                    Text(mobileText(R.string.skin_home_brand), Modifier.align(Alignment.CenterStart).padding(start = 24.dp),
                        fontFamily = LocalSkinTypefaces.current.brand, fontWeight = FontWeight(home.typography.brandWeight),
                        fontSize = home.typography.brandSize.sp)
                }
                SkinNewTask(home)
                Row(horizontalArrangement = Arrangement.spacedBy(home.layout.actionsGap.dp)) {
                    SkinPendingAction(home, "approvals", mobileText(R.string.label_approvals), SkinGlyph.Approval, 1, R.plurals.approval_tasks, Modifier.weight(1f), null)
                    SkinPendingAction(home, "questions", mobileText(R.string.question_answers), SkinGlyph.Question, 0, R.plurals.question_tasks, Modifier.weight(1f), null)
                }
                SkinSection(home, "shortcuts", Modifier.fillMaxWidth()) {
                    SkinShortcut(home, "unread", mobileText(R.string.label_unread), SkinGlyph.Unread, 2, R.plurals.unread_tasks, "cover-unread", home.layout.shortcutMinHeight.dp, null)
                }
                home.surfaces["shortcuts"]?.let { SkinSurface(it, Modifier.fillMaxWidth().weight(1f)) }
                if (home.layout.footerHeight > 0f) SkinSection(home, "footer", Modifier.fillMaxWidth().height(home.layout.footerHeight.dp)) {}
            }
        }
    }
}

@Composable
private fun SkinPendingAction(home: SkinHome, slot: String, label: String, glyph: SkinGlyph, count: Int?, meaning: Int, modifier: Modifier, onClick: (() -> Unit)?) {
    SkinSurface(home[slot], modifier.heightIn(min = home.layout.actionMinHeight.dp).testTag("home-$slot")
        .semantics { stateDescription = count?.let { mobileQuantity(meaning, it) } ?: mobileText(R.string.label_count_unavailable) }, onClick) {
        val bodyFont = LocalSkinTypefaces.current.body
        if (home.layout.actionArrangement == "inline") {
            Row(Modifier.fillMaxWidth().align(Alignment.Center).padding(home.layout.actionPadding.paddingValues()), verticalAlignment = Alignment.CenterVertically) {
                SkinIcon(glyph, home.iconStyle, Modifier.size(27.dp), Color(home[slot].icon))
                Spacer(Modifier.width(home.layout.actionIconGap.dp))
                Text(label, Modifier.weight(1f), fontFamily = bodyFont, fontSize = home.typography.labelSize.sp, lineHeight = (home.typography.labelSize * 1.25f).sp, fontWeight = FontWeight(home.typography.weight))
                Spacer(Modifier.width(home.layout.actionCountGap.dp))
                SkinCount(home, home["badge"], count)
            }
        } else {
            Column(Modifier.fillMaxWidth().align(Alignment.Center).padding(home.layout.actionPadding.paddingValues()), verticalArrangement = Arrangement.spacedBy(home.layout.actionIconGap.dp)) {
                SkinIcon(glyph, home.iconStyle, Modifier.size(42.dp), Color(home[slot].icon))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
                    Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(home.layout.actionCountGap.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(label, Modifier.weight(1f, fill = false), fontFamily = bodyFont, fontSize = home.typography.labelSize.sp, lineHeight = (home.typography.labelSize * 1.25f).sp, fontWeight = FontWeight(home.typography.weight))
                        SkinCount(home, home["badge"], count)
                    }
                    SkinIcon(SkinGlyph.Next, home.iconStyle, Modifier.size(16.dp))
                }
            }
        }
    }
}

@Composable
private fun SkinShortcut(home: SkinHome, slot: String, label: String, glyph: SkinGlyph, count: Int?, meaning: Int, tag: String, minHeight: androidx.compose.ui.unit.Dp, onClick: (() -> Unit)?) {
    SkinSurface(home[slot], Modifier.fillMaxWidth().heightIn(min = minHeight).testTag(tag)
        .semantics { stateDescription = count?.let { mobileQuantity(meaning, it) } ?: mobileText(R.string.label_count_unavailable) }, onClick) {
        Row(Modifier.fillMaxWidth().align(Alignment.Center).padding(home.layout.shortcutPadding.paddingValues()), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            SkinIcon(glyph, home.iconStyle, Modifier.size(28.dp).testTag("$tag-icon"), Color(home[slot].icon))
            Text(label, Modifier.weight(1f).testTag("$tag-label"), fontFamily = LocalSkinTypefaces.current.body, fontSize = home.typography.labelSize.sp, lineHeight = (home.typography.labelSize * 1.3f).sp, fontWeight = FontWeight(home.typography.weight))
            SkinCount(home, home[if (slot == "all") "allBadge" else home.layout.shortcutBadge], count)
            SkinIcon(SkinGlyph.Next, home.iconStyle, Modifier.size(18.dp))
        }
    }
}

@Composable
private fun SkinCount(home: SkinHome, style: SkinSurfaceStyle, count: Int?) {
    val minimum = (home.typography.countSize * LocalDensity.current.fontScale * 1.4f).dp
    Layout(content = {
        val number: @Composable BoxScope.() -> Unit = {
            Text(count?.toString() ?: "—", Modifier.align(Alignment.Center).padding(horizontal = 8.dp, vertical = 2.dp), fontFamily = LocalSkinTypefaces.current.body,
                color = LocalContentColor.current, fontSize = home.typography.countSize.sp, lineHeight = (home.typography.countSize * 1.2f).sp,
                fontWeight = FontWeight(home.typography.weight), maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (count == null || count == 0) Box(Modifier.testTag("skin-count"), content = number)
        else SkinSurface(style, Modifier.testTag("skin-count"), content = number)
    }) { children, constraints ->
        val child = children.single()
        val limit = minOf(constraints.maxWidth, 112.dp.roundToPx()).coerceAtLeast(constraints.minWidth)
        val height = maxOf(minimum.roundToPx(), child.minIntrinsicHeight(limit)).coerceIn(constraints.minHeight, constraints.maxHeight)
        val width = maxOf((height * home.typography.countAspectRatio).roundToInt(), child.minIntrinsicWidth(height)).coerceIn(constraints.minWidth, limit)
        val placeable = child.measure(Constraints.fixed(width, height))
        layout(width, height) { placeable.place(0, 0) }
    }
}
