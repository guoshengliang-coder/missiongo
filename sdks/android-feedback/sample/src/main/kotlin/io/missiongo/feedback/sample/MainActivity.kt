package io.missiongo.feedback.sample

import android.app.Activity
import android.os.Bundle
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import io.missiongo.feedback.FeedbackOptions
import io.missiongo.feedback.FeedbackPriority
import io.missiongo.feedback.FeedbackResult
import io.missiongo.feedback.FeedbackType
import io.missiongo.feedback.MissionGo
import io.missiongo.feedback.MissionGoLogLevel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

class MainActivity : Activity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        MissionGo.setCurrentScreen("sdk_sample")

        val status = TextView(this).apply { text = "已连接 MissionGo，可以开始反馈。" }
        val openEditor = Button(this).apply {
            text = "打开反馈页面"
            setOnClickListener {
                MissionGo.addBreadcrumb("sample_editor_opened")
                MissionGo.openFeedback(
                    this@MainActivity,
                    FeedbackOptions(
                        title = "Android App 使用问题",
                        type = FeedbackType.Bug,
                        context = mapOf("sample" to "true"),
                    ),
                ) { result ->
                    status.text = when (result) {
                        is FeedbackResult.Submitted -> "提交成功：${result.submission.itemKey}"
                        is FeedbackResult.Failed -> "提交失败：${result.message}"
                        FeedbackResult.Cancelled -> "已取消反馈"
                    }
                }
            }
        }
        val submit = Button(this).apply {
            text = "直接提交一条测试记录"
            setOnClickListener {
                isEnabled = false
                status.text = "正在提交…"
                MissionGo.log(MissionGoLogLevel.Info, "Sample feedback button tapped")
                scope.launch {
                    runCatching {
                        MissionGo.submitFeedback(
                            FeedbackOptions(
                                title = "Android SDK 自动提交测试",
                                description = "由 MissionGo Android 测试 APK 创建。",
                                type = FeedbackType.Bug,
                                priority = FeedbackPriority.Normal,
                                context = mapOf("sample" to "true"),
                            ),
                        )
                    }.onSuccess { result ->
                        status.text = "提交成功：${result.itemKey}"
                    }.onFailure { error ->
                        status.text = error.message ?: "提交失败"
                    }
                    isEnabled = true
                }
            }
        }
        val enqueue = Button(this).apply {
            text = "Queue background submission"
            setOnClickListener {
                val queueId = MissionGo.enqueueFeedback(
                    FeedbackOptions(
                        title = "Queued Android SDK sample feedback",
                        description = "This submission may wait for network connectivity.",
                        type = FeedbackType.Bug,
                        context = mapOf("sample" to "true", "delivery" to "background"),
                    ),
                )
                status.text = "Queued $queueId"
            }
        }
        setContentView(
            LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                val padding = (24 * resources.displayMetrics.density).toInt()
                setPadding(padding, padding, padding, padding)
                addView(status, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
                addView(openEditor, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
                addView(submit, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
                addView(enqueue, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            },
        )
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }
}
