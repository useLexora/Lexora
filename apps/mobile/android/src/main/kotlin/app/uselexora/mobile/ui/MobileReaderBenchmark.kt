package app.uselexora.mobile.ui

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import org.json.JSONObject
import java.io.File

internal class MobileReaderBenchmark(
    private val activity: Activity,
    private val seconds: Int,
    private val publish: (List<JSONObject>, List<JSONObject>) -> Unit,
) {
    private val handler = Handler(Looper.getMainLooper())
    private val output = File(activity.getExternalFilesDir(null), "reader-benchmark.json")
    private var cancelled = false
    private var text = "## 持续输出\n\n"
    private var step = 0
    private var started = 0L
    private var cpuStarted = 0L
    private val updateTimes = mutableListOf<Long>()
    private val history = (0 until 500).map { message("history-$it", "history-run-$it", "历史 $it\n\n" + "这是一段用于滚动与流式验收的公开正文。".repeat(24)) }
    private fun message(id: String, run: String, text: String) = JSONObject().put("id", id).put("role", "assistant")
        .put("runId", run).put("author", JSONObject().put("id", "default").put("name", "Lexora"))
        .put("body", JSONObject().put("kind", "text").put("text", text))
    private fun run(status: String) = JSONObject("""{"id":"benchmark-stream","buddyId":"default","approvalPolicy":"manual","branchId":"benchmark","completedAt":null,"conversationId":"benchmark","errorCode":null,"executionProfile":"read_only","generation":"1","lastEventSequence":"0","modelId":"benchmark","providerId":"benchmark","purpose":"chat","reasoningLevel":null,"startedAt":"2026-11-11T05:00:00Z","status":"running","triggeringMessageId":"benchmark-user"}""").put("status", status)
    private fun reader(view: View): ReaderView? {
        if (view is ReaderView) return view
        if (view is ViewGroup) for (index in 0 until view.childCount) reader(view.getChildAt(index))?.let { return it }
        return null
    }
    fun start() {
        publish(history + message("stream", "benchmark-stream", text), listOf(run("running")))
        val deadline = SystemClock.elapsedRealtime() + 15000
        fun awaitReader() {
            if (cancelled) return
            val view = reader(activity.window.decorView)
            if (view?.readyForBenchmark == true) handler.postDelayed({
                view.beginFrameProbe(); started = SystemClock.elapsedRealtime(); cpuStarted = Process.getElapsedCpuTime(); tick()
            }, 2000)
            else if (SystemClock.elapsedRealtime() < deadline) handler.postDelayed({ awaitReader() }, 100)
            else output.writeText(JSONObject().put("error", "READER_UNAVAILABLE").toString())
        }
        awaitReader()
    }
    private fun tick() {
        if (cancelled) return
        if (step < seconds * 20) {
            text += if (step % 20 == 0) "\n\n第 ${step / 20} 段：**保留历史与输入**。" else "继续输出文字😀 "
            val before = SystemClock.elapsedRealtime()
            publish(history + message("stream", "benchmark-stream", text), listOf(run("running")))
            updateTimes.add(SystemClock.elapsedRealtime() - before)
            step++
            handler.postDelayed({ tick() }, 50)
        } else {
            text += "\n\n持续输出结束标记"
            publish(history + message("stream", "benchmark-stream", text), listOf(run("completed")))
            handler.postDelayed({
                reader(activity.window.decorView)?.finishFrameProbe { frames ->
                    val ordered = updateTimes.sorted()
                    frames.put("historyMessages", history.size).put("updates", step).put("elapsedMs", SystemClock.elapsedRealtime() - started)
                        .put("mainCpuMs", Process.getElapsedCpuTime() - cpuStarted).put("nativeUpdateP95Ms", ordered[((ordered.size - 1) * .95).toInt()])
                    output.writeText(frames.toString())
                }
            }, 1000)
        }
    }
    fun close() { cancelled = true; handler.removeCallbacksAndMessages(null) }
}
