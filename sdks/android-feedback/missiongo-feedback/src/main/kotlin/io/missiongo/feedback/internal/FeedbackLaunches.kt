package io.missiongo.feedback.internal

import io.missiongo.feedback.FeedbackResult
import io.missiongo.feedback.FeedbackResultCallback
import java.util.concurrent.ConcurrentHashMap

internal object FeedbackLaunchCallbacks {
    private val callbacks = ConcurrentHashMap<String, FeedbackResultCallback>()

    fun register(id: String, callback: FeedbackResultCallback?) {
        if (callback != null) callbacks[id] = callback
    }

    fun complete(id: String, result: FeedbackResult) {
        callbacks.remove(id)?.onResult(result)
    }

    fun discard(id: String) {
        callbacks.remove(id)
    }
}
