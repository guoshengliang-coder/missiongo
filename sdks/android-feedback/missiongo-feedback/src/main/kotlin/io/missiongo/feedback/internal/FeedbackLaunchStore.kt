package io.missiongo.feedback.internal

import io.missiongo.feedback.FeedbackOptions
import io.missiongo.feedback.FeedbackPriority
import io.missiongo.feedback.FeedbackType
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

internal class FeedbackLaunchStore(
    private val directory: File,
    private val maxAgeMillis: Long = 24 * 60 * 60 * 1_000L,
) {
    @Synchronized
    fun put(payload: PendingFeedback): String {
        cleanup()
        val id = UUID.randomUUID().toString()
        write(id, payload)
        return id
    }

    @Synchronized
    fun get(id: String?): PendingFeedback? {
        if (!isValidId(id)) return null
        val target = file(id!!)
        val source = if (target.isFile) target else backupFile(id).takeIf(File::isFile) ?: return null
        if (System.currentTimeMillis() - source.lastModified() > maxAgeMillis) {
            remove(id)
            return null
        }
        val decoded = runCatching { decode(JSONObject(source.readText(Charsets.UTF_8))) }.getOrNull()
        if (decoded == null) remove(id)
        return decoded
    }

    @Synchronized
    fun setDraftId(id: String, draftId: String) {
        val current = get(id) ?: return
        write(id, current.copy(draftId = draftId))
    }

    @Synchronized
    fun remove(id: String) {
        if (!isValidId(id)) return
        file(id).delete()
        temporaryFile(id).delete()
        backupFile(id).delete()
    }

    @Synchronized
    fun cleanup() {
        val cutoff = System.currentTimeMillis() - maxAgeMillis
        directory.listFiles()?.filter { it.lastModified() < cutoff }?.forEach(File::delete)
    }

    private fun write(id: String, payload: PendingFeedback) {
        check(directory.exists() || directory.mkdirs()) { "Could not create the MissionGo pending-feedback directory." }
        val bytes = encode(payload).toString().toByteArray(Charsets.UTF_8)
        require(bytes.size <= 512 * 1024) { "Pending feedback must be 512 KiB or smaller." }
        val target = file(id)
        val temporary = temporaryFile(id)
        val backup = backupFile(id)
        temporary.outputStream().use { stream ->
            stream.write(bytes)
            stream.flush()
            stream.fd.sync()
        }
        backup.delete()
        if (target.exists() && !target.renameTo(backup)) {
            temporary.delete()
            error("Could not preserve the previous MissionGo pending-feedback file.")
        }
        if (!temporary.renameTo(target)) {
            backup.renameTo(target)
            temporary.delete()
            error("Could not persist MissionGo pending feedback.")
        }
        backup.delete()
    }

    private fun encode(payload: PendingFeedback): JSONObject = JSONObject().apply {
        put("createdAt", System.currentTimeMillis())
        payload.draftId?.let { put("draftId", it) }
        put("options", JSONObject().apply {
            put("title", payload.options.title)
            put("description", payload.options.description)
            put("type", payload.options.type.wireValue)
            put("priority", payload.options.priority.wireValue)
            put("clientDraftId", payload.options.clientDraftId)
        })
        put("environment", JSONObject().apply {
            payload.environment.appVersion?.let { put("appVersion", it) }
            payload.environment.buildNumber?.let { put("buildNumber", it) }
            payload.environment.sourceRevision?.let { put("sourceRevision", it) }
            put("osVersion", payload.environment.osVersion)
            put("deviceModel", payload.environment.deviceModel)
            put("metadata", JSONObject(payload.environment.metadata))
        })
        put("context", JSONObject(payload.context))
        put("logs", JSONArray().apply {
            payload.logs.forEach { log ->
                put(JSONObject().apply {
                    put("timestamp", log.timestamp)
                    put("level", log.level)
                    put("message", log.message)
                    put("attributes", JSONObject(log.attributes))
                })
            }
        })
    }

    private fun decode(json: JSONObject): PendingFeedback {
        val optionsJson = json.getJSONObject("options")
        val environmentJson = json.getJSONObject("environment")
        return PendingFeedback(
            options = FeedbackOptions(
                title = optionsJson.getString("title"),
                description = optionsJson.getString("description"),
                type = FeedbackType.entries.first { it.wireValue == optionsJson.getString("type") },
                priority = FeedbackPriority.entries.first { it.wireValue == optionsJson.getString("priority") },
                clientDraftId = optionsJson.getString("clientDraftId"),
            ),
            environment = FeedbackEnvironment(
                appVersion = environmentJson.optionalString("appVersion"),
                buildNumber = environmentJson.optionalString("buildNumber"),
                sourceRevision = environmentJson.optionalString("sourceRevision"),
                osVersion = environmentJson.getString("osVersion"),
                deviceModel = environmentJson.getString("deviceModel"),
                metadata = environmentJson.getJSONObject("metadata").stringMap(),
            ),
            context = json.getJSONObject("context").stringMap(),
            logs = json.getJSONArray("logs").let { logs ->
                List(logs.length()) { index ->
                    val log = logs.getJSONObject(index)
                    FeedbackLogEntry(
                        timestamp = log.getString("timestamp"),
                        level = log.getString("level"),
                        message = log.getString("message"),
                        attributes = log.getJSONObject("attributes").stringMap(),
                    )
                }
            },
            draftId = json.optionalString("draftId"),
        )
    }

    private fun JSONObject.optionalString(name: String): String? =
        optString(name).takeIf { has(name) && it.isNotBlank() }

    private fun JSONObject.stringMap(): Map<String, String> = keys().asSequence().associateWith(::getString)

    private fun file(id: String): File = File(directory, "$id.json")
    private fun temporaryFile(id: String): File = File(directory, "$id.tmp")
    private fun backupFile(id: String): File = File(directory, "$id.bak")
    private fun isValidId(id: String?): Boolean = id?.matches(ID_PATTERN) == true

    private companion object {
        val ID_PATTERN = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
    }
}
