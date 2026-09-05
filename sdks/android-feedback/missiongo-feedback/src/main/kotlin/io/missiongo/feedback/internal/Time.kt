package io.missiongo.feedback.internal

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

internal fun utcTimestamp(nowMillis: Long = System.currentTimeMillis()): String = synchronized(UtcClock.formatter) {
    UtcClock.formatter.format(Date(nowMillis))
}

private object UtcClock {
    val formatter = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
        timeZone = TimeZone.getTimeZone("UTC")
    }
}
