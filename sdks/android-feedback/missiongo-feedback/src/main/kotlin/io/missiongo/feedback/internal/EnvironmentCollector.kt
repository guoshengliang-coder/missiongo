package io.missiongo.feedback.internal

import android.app.Application
import android.content.pm.PackageInfo
import android.os.Build
import android.util.DisplayMetrics
import io.missiongo.feedback.MissionGoOptions
import java.util.Locale
import java.util.TimeZone

internal object EnvironmentCollector {
    fun collect(application: Application, options: MissionGoOptions): FeedbackEnvironment {
        val packageInfo = application.packageManager.getPackageInfo(application.packageName, 0)
        val metrics: DisplayMetrics = application.resources.displayMetrics
        return FeedbackEnvironment(
            appVersion = packageInfo.versionName,
            buildNumber = packageInfo.versionCodeCompat().toString(),
            sourceRevision = options.sourceRevision?.takeIf(String::isNotBlank),
            osVersion = "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})",
            deviceModel = listOf(Build.MANUFACTURER, Build.MODEL)
                .map(String::trim)
                .filter(String::isNotEmpty)
                .distinctBy(String::lowercase)
                .joinToString(" "),
            metadata = buildMap {
                put("packageName", application.packageName)
                put("locale", Locale.getDefault().toLanguageTag())
                put("timeZone", TimeZone.getDefault().id)
                put("screenDensityDpi", metrics.densityDpi.toString())
                Build.SUPPORTED_ABIS.firstOrNull()?.let { put("primaryAbi", it) }
                options.buildFlavor?.takeIf(String::isNotBlank)?.let { put("buildFlavor", it) }
                options.distributionChannel?.takeIf(String::isNotBlank)?.let { put("distributionChannel", it) }
            },
        )
    }
}

@Suppress("DEPRECATION")
private fun PackageInfo.versionCodeCompat(): Long =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) longVersionCode else versionCode.toLong()
