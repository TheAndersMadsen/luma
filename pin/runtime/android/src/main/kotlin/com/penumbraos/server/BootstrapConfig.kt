package com.penumbraos.server

import android.content.Context
import android.os.Environment
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.nio.charset.StandardCharsets
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption

object BootstrapConfig {

    private const val TAG = "PenumbraServer"
    private const val BOOTSTRAP_ASSET = "bootstrap-config.toml"
    private const val CONFIG_FILE_NAME = "config.toml"
    private const val LOCAL_CONFIG_FILE_NAME = "config.local.toml"
    private const val CONFIG_SECURITY_SCHEMA_FILE_NAME = ".config-security-schema"
    private const val CONFIG_SECURITY_SCHEMA_VERSION = "1"
    private const val MEDIA_DIR_NAME = "media"
    private const val DB_FILE_NAME = "penumbra.db"
    private const val DATABASE_DIR_NAME = "database"
    private const val LOG_DIR_NAME = "logs"
    private const val MEMORY_FILE_NAME = "assistant-memory.mv2"
    private const val MEMORY_DIR_NAME = "memory"
    private const val MEMORY_SECTION = "llm.memory"
    private const val MEMORY_PATH_KEY = "path"
    private const val STORAGE_SECTION = "storage"
    private const val STORAGE_DB_PATH_KEY = "db_path"
    private const val LOGGING_SECTION = "logging"
    private const val LOGGING_DIR_KEY = "log_dir"
    private const val PREVIOUS_EXTERNAL_STORAGE_ALIAS = "/sdcard"
    private const val STORAGE_MEDIA_PLACEHOLDER = "__APP_MEDIA_DIR__"
    private const val STORAGE_DB_PLACEHOLDER = "__APP_DB_PATH__"
    private const val LOG_DIR_PLACEHOLDER = "__APP_LOG_DIR__"
    private const val MEMORY_PATH_PLACEHOLDER = "__APP_MEMORY_PATH__"
    private const val ADMIN_TOKEN_PLACEHOLDER = "__APP_ADMIN_TOKEN__"
    private const val PERSISTENT_ROOT_DIR_NAME = "PenumbraOS"
    private val PREVIOUS_DEFAULT_SYSTEM_PROMPT_LINES = listOf(
        "system_prompt = \"You are a helpful assistant running on a Humane AI Pin. Keep responses concise - they will be displayed on a laser projector and spoken aloud.\"",
    )
    private val PREVIOUS_DEFAULT_STATUS_PROMPT_LINES = listOf(
        "status_prompt = \"\"\"",
        "Current request status:",
        "- Current timestamp: {{current_timestamp}}",
        "- Current date: {{current_date}}",
        "- Current time: {{current_time}}",
        "{{#if location_name}}- User location: {{location_name}}{{else}}- User location: unknown",
        "{{/if}}{{#if coordinates}}- User coordinates: {{coordinates}}",
        "{{/if}}",
        "This status applies to the current user request only. If it conflicts with earlier conversation history, prefer this current status.",
        "\"\"\"",
    )

    fun ensurePersistentRoot(): File {
        val externalRoot = File(Environment.getExternalStorageDirectory(), PERSISTENT_ROOT_DIR_NAME)

        check(externalRoot.exists() || externalRoot.mkdirs()) {
            "Failed to create persistent storage dir at ${externalRoot.absolutePath}"
        }

        return externalRoot
    }

    internal fun databaseFile(context: Context): File {
        val externalFiles = checkNotNull(context.getExternalFilesDir(null)) {
            "App-scoped external storage is unavailable"
        }
        return File(File(externalFiles, DATABASE_DIR_NAME), DB_FILE_NAME)
    }

    fun ensureCanonicalConfig(context: Context): String {
        val externalRoot = ensurePersistentRoot()

        val configFile = File(context.filesDir, CONFIG_FILE_NAME)
        val localConfigFile = File(context.filesDir, LOCAL_CONFIG_FILE_NAME)
        val securitySchemaFile = File(context.filesDir, CONFIG_SECURITY_SCHEMA_FILE_NAME)
        val legacyConfigFile = File(externalRoot, CONFIG_FILE_NAME)
        val legacyLocalConfigFile = File(externalRoot, LOCAL_CONFIG_FILE_NAME)
        val mediaDir = File(externalRoot, MEDIA_DIR_NAME)
        val externalLegacyDbFile = File(externalRoot, DB_FILE_NAME)
        val credentialLegacyDbFile = context.getDatabasePath(DB_FILE_NAME)
        val deviceLegacyDbFile =
            context.createDeviceProtectedStorageContext().getDatabasePath(DB_FILE_NAME)
        // Both CE and DE app-data directories are recreated while Package
        // Manager reconciles this injected shared-UID package. App-scoped
        // external storage survives that reconciliation; SQLCipher protects
        // the database there before the native runtime accepts it.
        val dbFile = databaseFile(context)
        val legacyLogDir = File(externalRoot, LOG_DIR_NAME)
        val logDir = File(context.filesDir, LOG_DIR_NAME)
        // memvid takes an fs2 advisory flock on the memory file. The primary
        // shared volume that hosts ensurePersistentRoot() is served by FUSE
        // (/dev/fuse on /storage/emulated), and that FUSE daemon answers flock
        // with ENOSYS, so the memory file cannot live beside the other
        // persistent artifacts. getExternalFilesDir is reached through the
        // Android/data bind mount, which is served by the same filesystem that
        // backs /data and does support flock. This is not app-private internal
        // storage; it is the app-scoped directory on the shared volume, so it
        // stays readable for host-side backup while remaining flock-capable.
        // Existing memory files at the legacy shared-volume paths are migrated
        // on first run.
        val memoryDir = File(context.getExternalFilesDir(null), MEMORY_DIR_NAME)
        check(memoryDir.exists() || memoryDir.mkdirs()) {
            "Failed to create memory dir at ${memoryDir.absolutePath}"
        }
        val memoryFile = File(memoryDir, MEMORY_FILE_NAME)
        val legacyMemoryFiles = legacyMemoryFiles(externalRoot)
        migrateLegacyMemoryFile(legacyMemoryFiles, memoryFile)
        val privateConfigExistedAtStart = configFile.exists()

        check(mediaDir.exists() || mediaDir.mkdirs()) {
            "Failed to create media dir at ${mediaDir.absolutePath}"
        }

        check(dbFile.parentFile?.exists() == true || dbFile.parentFile?.mkdirs() == true) {
            "Failed to create db parent dir at ${dbFile.parentFile?.absolutePath}"
        }

        check(logDir.exists() || logDir.mkdirs()) {
            "Failed to create log dir at ${logDir.absolutePath}"
        }

        Log.w(
            TAG,
            "Resolved storage paths: " +
                "root=${externalRoot.absolutePath}, " +
                "config=${configFile.absolutePath}, " +
                "db=${dbFile.absolutePath}, " +
                "media=${mediaDir.absolutePath}, " +
                "logs=${logDir.absolutePath}, " +
                "memory=${memoryFile.absolutePath}",
        )

        val resetUnprovenPrivateConfig = resetUnprovenPrivateConfigIfNeeded(
                configFile,
                localConfigFile,
                securitySchemaFile,
            )
        if (resetUnprovenPrivateConfig) {
            Log.w(TAG, "Reset unproven app-private configuration to safe defaults")
        }

        if (!configFile.exists()) {
            if (importUntrustedLegacyBaseConfig(configFile, legacyConfigFile)) {
                Log.w(TAG, "Replaced untrusted legacy config with safe app-private defaults")
            } else {
                val bootstrapToml =
                    context.assets.open(BOOTSTRAP_ASSET).bufferedReader().use { it.readText() }
                val renderedToml = bootstrapToml
                    .replace(STORAGE_MEDIA_PLACEHOLDER, mediaDir.absolutePath)
                    .replace(STORAGE_DB_PLACEHOLDER, dbFile.absolutePath)
                    .replace(LOG_DIR_PLACEHOLDER, logDir.absolutePath)
                    .replace(MEMORY_PATH_PLACEHOLDER, memoryFile.absolutePath)
                    .replace(ADMIN_TOKEN_PLACEHOLDER, ConfigSecurity.generateAdminToken())

                writePrivateConfig(configFile, renderedToml)
                Log.w(TAG, "Wrote canonical config in app-private storage")
            }
        } else {
            check(!Files.isSymbolicLink(configFile.toPath())) {
                "Refusing to use a symbolic-link canonical config"
            }
            Log.w(TAG, "Using existing app-private canonical config")
        }

        if (localConfigFile.exists()) {
            check(!Files.isSymbolicLink(localConfigFile.toPath())) {
                "Refusing to use a symbolic-link local config"
            }
        } else if (legacyLocalConfigFile.exists() ||
            Files.isSymbolicLink(legacyLocalConfigFile.toPath())
        ) {
            Log.w(TAG, "Ignored untrusted legacy local config overlay")
        }

        val legacyDbPaths = listOf(
            externalLegacyDbFile.absolutePath,
            "$PREVIOUS_EXTERNAL_STORAGE_ALIAS/$PERSISTENT_ROOT_DIR_NAME/$DB_FILE_NAME",
            credentialLegacyDbFile.absolutePath,
            deviceLegacyDbFile.absolutePath,
        )
        val legacyLogPaths = listOf(
            legacyLogDir.absolutePath,
            "$PREVIOUS_EXTERNAL_STORAGE_ALIAS/$PERSISTENT_ROOT_DIR_NAME/$LOG_DIR_NAME",
        )
        val dbPathNeedsRetarget = retargetLegacyDatabasePath(
            configFile.readText(),
            legacyDbPaths,
            dbFile.absolutePath,
        ).second
        val migrationState = DatabaseStorage.migrationStateFile(dbFile)
        val legacyDbFile = listOf(
            externalLegacyDbFile,
            credentialLegacyDbFile,
            deviceLegacyDbFile,
        ).firstOrNull {
            it.exists() || Files.isSymbolicLink(it.toPath())
        }
        val legacyDbPresent = legacyDbFile != null
        if (legacyDbPresent &&
            (dbPathNeedsRetarget ||
                !privateConfigExistedAtStart ||
                resetUnprovenPrivateConfig ||
                migrationState.exists() ||
                Files.isSymbolicLink(migrationState.toPath()))
        ) {
            val migrated = DatabaseStorage.migrateLegacyDatabase(checkNotNull(legacyDbFile), dbFile)
            Log.w(
                TAG,
                if (migrated) {
                    "Staged SQLite database in durable app-scoped storage"
                } else {
                    "Validated existing durable SQLite database staging"
                },
            )
        }
        applyAndroidConfigMigrations(
            configFile,
            managedFields(mediaDir, dbFile, logDir, memoryFile),
            legacyDbPaths = legacyDbPaths,
            dbPath = dbFile.absolutePath,
            legacyLogPaths = legacyLogPaths,
            logPath = logDir.absolutePath,
            legacyMemoryPaths = legacyMemoryFiles.map { it.absolutePath },
            memoryPath = memoryFile.absolutePath,
        )
        if (localConfigFile.exists()) {
            applyAndroidLocalConfigMigrations(localConfigFile)
        }
        // Validate the exact effective token before removing the recoverable
        // legacy source. This value is intentionally neither returned here nor
        // logged.
        readEffectiveAdminToken(configFile.absolutePath)
        if (DatabaseStorage.migrationIsComplete(dbFile) &&
            ConfigSecurity.readOptionalString(
                configFile.readText(),
                "$STORAGE_SECTION.$STORAGE_DB_PATH_KEY",
            ) == dbFile.absolutePath
        ) {
            DatabaseStorage.retireLegacyDatabase(credentialLegacyDbFile)
            DatabaseStorage.retireLegacyDatabase(deviceLegacyDbFile)
            DatabaseStorage.retireLegacyDatabase(externalLegacyDbFile)
        }
        if (ConfigSecurity.readOptionalString(
                configFile.readText(),
                "$LOGGING_SECTION.$LOGGING_DIR_KEY",
            ) == logDir.absolutePath
        ) {
            LogStorage.retireLegacyLogs(legacyLogDir)
        }
        removeLegacyConfigArtifacts(legacyConfigFile, legacyLocalConfigFile)
        writePrivateConfigSecuritySchema(securitySchemaFile)

        return configFile.absolutePath
    }

    /**
     * The vulnerable intermediate private-config migration did not write a
     * provenance marker. Consequently, any pre-existing private config without
     * the current marker must be treated as if every field was attacker chosen.
     * Released-HEAD upgrades have no private config and follow the normal safe
     * legacy replacement path below, so they are not mistaken for this state.
     */
    internal fun resetUnprovenPrivateConfigIfNeeded(
        privateConfigFile: File,
        privateLocalConfigFile: File,
        securitySchemaFile: File,
        tokenGenerator: () -> String = { ConfigSecurity.generateAdminToken() },
    ): Boolean {
        if (hasCurrentPrivateConfigSecuritySchema(securitySchemaFile)) return false

        val privateArtifacts = listOf(
            privateConfigFile,
            privateLocalConfigFile,
            File(privateConfigFile.parentFile, "${privateConfigFile.name}.bak"),
            File(privateLocalConfigFile.parentFile, "${privateLocalConfigFile.name}.bak"),
        )
        val hadUnprovenArtifacts = privateArtifacts.any {
            it.exists() || Files.isSymbolicLink(it.toPath())
        }
        if (!hadUnprovenArtifacts) return false

        writePrivateConfig(
            privateConfigFile,
            ConfigSecurity.createSafeLegacyReplacement(tokenGenerator),
        )
        privateArtifacts
            .filterNot { it == privateConfigFile }
            .forEach(::removePrivateConfigArtifact)
        return true
    }

    internal fun hasCurrentPrivateConfigSecuritySchema(securitySchemaFile: File): Boolean {
        check(!Files.isSymbolicLink(securitySchemaFile.toPath())) {
            "Refusing to use a symbolic-link private config security schema"
        }
        if (!securitySchemaFile.isFile) return false
        return securitySchemaFile.readText() == "$CONFIG_SECURITY_SCHEMA_VERSION\n"
    }

    internal fun writePrivateConfigSecuritySchema(securitySchemaFile: File) {
        if (hasCurrentPrivateConfigSecuritySchema(securitySchemaFile)) return
        writePrivateConfig(securitySchemaFile, "$CONFIG_SECURITY_SCHEMA_VERSION\n")
    }

    internal fun importUntrustedLegacyBaseConfig(
        privateConfigFile: File,
        legacyConfigFile: File,
        tokenGenerator: () -> String = { ConfigSecurity.generateAdminToken() },
    ): Boolean {
        val legacyPresent = legacyConfigFile.exists() ||
            Files.isSymbolicLink(legacyConfigFile.toPath())
        if (privateConfigFile.exists() || !legacyPresent) return false
        val imported = ConfigSecurity.createSafeLegacyReplacement(tokenGenerator)
        writePrivateConfig(privateConfigFile, imported)
        return true
    }

    private data class ManagedField(val section: String, val key: String, val value: String)

    /**
     * Every spelling of the pre-relocation memory file. The shared volume is
     * reachable both through the resolved external storage root and through the
     * `/sdcard` compatibility symlink, and an older config may hold either.
     */
    private fun legacyMemoryFiles(externalRoot: File): List<File> = listOf(
        File(externalRoot, MEMORY_FILE_NAME),
        File(
            File(PREVIOUS_EXTERNAL_STORAGE_ALIAS, PERSISTENT_ROOT_DIR_NAME),
            MEMORY_FILE_NAME,
        ),
    )

    /**
     * One-shot copy of assistant-memory.mv2 off the FUSE-served shared volume,
     * where fs2 flock fails with ENOSYS and memvid-core cannot open the store,
     * into the flock-capable app-scoped directory. The legacy file is left in
     * place as a manual-recovery fallback until the new path is proven stable.
     *
     * A legacy file that is newer than an existing target is never copied over
     * the target; that combination means a previous relocation was followed by
     * further writes to the old path, and choosing a winner automatically could
     * discard memories. It is reported instead.
     */
    private fun migrateLegacyMemoryFile(legacyFiles: List<File>, targetFile: File) {
        val legacyFile = legacyFiles.firstOrNull { it.exists() } ?: return
        if (targetFile.exists()) {
            if (legacyFile.lastModified() > targetFile.lastModified()) {
                Log.w(
                    TAG,
                    "Legacy memory file at ${legacyFile.absolutePath} is newer than " +
                        "${targetFile.absolutePath}; keeping the relocated file and " +
                        "leaving the legacy file for manual recovery",
                )
            }
            return
        }
        try {
            legacyFile.copyTo(targetFile, overwrite = false)
            Log.w(TAG, "Migrated memory file from ${legacyFile.absolutePath} to ${targetFile.absolutePath}")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to migrate memory file: ${e.message}")
        }
    }

    private data class SectionBounds(val headerIdx: Int, val endIdx: Int)

    private fun managedFields(
        mediaDir: File,
        dbFile: File,
        logDir: File,
        memoryFile: File,
    ): List<ManagedField> = listOf(
        ManagedField("storage", "media_dir", mediaDir.absolutePath),
        ManagedField("storage", "db_path", dbFile.absolutePath),
        ManagedField("logging", "log_dir", logDir.absolutePath),
        ManagedField("llm.memory", "path", memoryFile.absolutePath),
    )

    /**
     * Idempotent Android config migrations. Existing custom values are never
     * overwritten. Migration is strict because starting with a half-migrated
     * config would either expose credentials or make the USB bridge unable to
     * authenticate.
     */
    private fun applyAndroidConfigMigrations(
        configFile: File,
        fields: List<ManagedField>,
        legacyDbPaths: List<String>,
        dbPath: String,
        legacyLogPaths: List<String>,
        logPath: String,
        legacyMemoryPaths: List<String>,
        memoryPath: String,
    ) {
        val original = configFile.readText()

        var text = original
        val bySection = fields.groupBy { it.section }
        var changedAny = false
        var addedAdminToken = false
        var migratedLegacyHttpBind = false
        var addedManagedDefaults = false
        var retargetedDatabasePath = false
        var retargetedLogPath = false
        var retargetedMemoryPath = false
        var removedLegacySystemPrompt = false
        var removedLegacyStatusPrompt = false

        val bindMigration = ConfigSecurity.migrateLegacyWildcardBind(text)
        if (bindMigration.changed) {
            text = bindMigration.text
            changedAny = true
            migratedLegacyHttpBind = true
        }

        val tokenMigration = ConfigSecurity.ensureAdminToken(text)
        if (tokenMigration.changed) {
            text = tokenMigration.text
            changedAny = true
            addedAdminToken = true
        }

        for ((section, items) in bySection) {
            val (newText, changed) = ensureFieldsInSection(text, section, items)
            if (changed) {
                text = newText
                changedAny = true
                addedManagedDefaults = true
            }
        }

        val dbRetarget = retargetLegacyDatabasePath(text, legacyDbPaths, dbPath)
        if (dbRetarget.second) {
            text = dbRetarget.first
            changedAny = true
            retargetedDatabasePath = true
        }

        val logRetarget = retargetLegacyLogPath(text, legacyLogPaths, logPath)
        if (logRetarget.second) {
            text = logRetarget.first
            changedAny = true
            retargetedLogPath = true
        }

        // Runs after the insert-only pass so a freshly inserted key is already
        // correct and this becomes a no-op.
        val memoryRetarget = retargetLegacyMemoryPath(text, legacyMemoryPaths, memoryPath)
        if (memoryRetarget.second) {
            text = memoryRetarget.first
            changedAny = true
            retargetedMemoryPath = true
        }

        val (textWithoutLegacySystemPrompt, removedSystemPrompt) =
            removeLegacyDefaultPrompt(text, PREVIOUS_DEFAULT_SYSTEM_PROMPT_LINES)
        if (removedSystemPrompt) {
            text = textWithoutLegacySystemPrompt
            changedAny = true
            removedLegacySystemPrompt = true
        }

        val (textWithoutLegacyStatusPrompt, removedStatusPrompt) =
            removeLegacyDefaultPrompt(text, PREVIOUS_DEFAULT_STATUS_PROMPT_LINES)
        if (removedStatusPrompt) {
            text = textWithoutLegacyStatusPrompt
            changedAny = true
            removedLegacyStatusPrompt = true
        }

        if (!changedAny) return

        val scrubbedBackup = ConfigSecurity.scrubWriteOnlySecretsForBackup(original)
        val bak = File(configFile.parentFile, "${configFile.name}.bak")
        writePrivateConfig(bak, scrubbedBackup)
        writePrivateConfig(configFile, text)
        Log.w(
            TAG,
            "Migrated app-private canonical config: " +
                "addedAdminToken=$addedAdminToken, " +
                "migratedLegacyHttpBind=$migratedLegacyHttpBind, " +
                "addedManagedDefaults=$addedManagedDefaults, " +
                "retargetedDatabasePath=$retargetedDatabasePath, " +
                "retargetedLogPath=$retargetedLogPath, " +
                "retargetedMemoryPath=$retargetedMemoryPath, " +
                "removedLegacySystemPrompt=$removedLegacySystemPrompt, " +
                "removedLegacyStatusPrompt=$removedLegacyStatusPrompt",
        )
    }

    /**
     * Keep the optional overlay private while making the base config the only
     * persisted Android authority for the administration token.
     */
    private fun applyAndroidLocalConfigMigrations(configFile: File) {
        val original = configFile.readText()
        val migration = ConfigSecurity.prepareAndroidLocalOverlay(original)
        if (!migration.changed) return

        val scrubbedBackup = ConfigSecurity.scrubWriteOnlySecretsForBackup(original)
        val bak = File(configFile.parentFile, "${configFile.name}.bak")
        writePrivateConfig(bak, scrubbedBackup)
        writePrivateConfig(configFile, migration.text)
        Log.w(TAG, "Migrated app-private local config overlay")
    }

    /**
     * Returns (newText, changed). Inserts any of `items` whose `key` is not
     * already present under `[section]`. If `[section]` is absent, appends a
     * fresh section at end of file.
     */
    private fun ensureFieldsInSection(
        text: String,
        section: String,
        items: List<ManagedField>,
    ): Pair<String, Boolean> {
        val lines = text.lines().toMutableList()
        val structuralLines = ConfigSecurity.structuralCodeByLine(text)
        val bounds = findSectionBounds(structuralLines, section)

        if (bounds == null) {
            val sb = StringBuilder(text)
            if (text.isNotEmpty() && !text.endsWith("\n")) sb.append("\n")
            if (text.isNotEmpty() && !text.endsWith("\n\n")) sb.append("\n")
            sb.append("[").append(section).append("]\n")
            for (f in items) {
                sb.append(f.key).append(" = \"").append(escapeToml(f.value)).append("\"\n")
            }
            return sb.toString() to true
        }

        val presentKeys = mutableSetOf<String>()
        for (i in bounds.headerIdx + 1 until bounds.endIdx) {
            val t = structuralLines[i].trim()
            if (t.isEmpty()) continue
            val eq = t.indexOf('=')
            if (eq > 0) presentKeys += t.substring(0, eq).trim()
        }

        val missing = items.filterNot { it.key in presentKeys }
        if (missing.isEmpty()) return text to false

        val toInsert = missing.map { """${it.key} = "${escapeToml(it.value)}"""" }
        lines.addAll(bounds.headerIdx + 1, toInsert)
        return lines.joinToString("\n") to true
    }

    /**
     * Returns (newText, changed). Rewrites `[llm.memory] path` when it still
     * holds one of the flock-incapable legacy shared-volume values.
     *
     * `ensureFieldsInSection` is insert-only, so relocating the memory file in
     * code alone never reaches a device that already has a canonical config:
     * the key is present, the managed default is skipped, and the server keeps
     * opening the old path and failing its lock. This is the one managed field
     * whose stale value must be replaced. The rewrite is deliberately narrow —
     * it matches the exact legacy paths this project generated and leaves any
     * other value, including an operator's own, untouched.
     */
    internal fun retargetLegacyMemoryPath(
        text: String,
        legacyPaths: List<String>,
        memoryPath: String,
    ): Pair<String, Boolean> {
        if (memoryPath in legacyPaths) return text to false

        val structuralLines = ConfigSecurity.structuralCodeByLine(text)
        val bounds = findSectionBounds(structuralLines, MEMORY_SECTION) ?: return text to false
        val lines = text.lines().toMutableList()

        for (i in bounds.headerIdx + 1 until bounds.endIdx) {
            val trimmed = structuralLines[i].trim()
            val eq = trimmed.indexOf('=')
            if (eq <= 0 || trimmed.substring(0, eq).trim() != MEMORY_PATH_KEY) continue

            val current = parseTomlBasicString(trimmed.substring(eq + 1).trim())
            if (current == null || current !in legacyPaths) return text to false

            lines[i] = """$MEMORY_PATH_KEY = "${escapeToml(memoryPath)}""""
            return lines.joinToString("\n") to true
        }

        return text to false
    }

    /** Rewrite only database paths previously generated on shared storage. */
    internal fun retargetLegacyDatabasePath(
        text: String,
        legacyPaths: List<String>,
        databasePath: String,
    ): Pair<String, Boolean> {
        if (databasePath in legacyPaths) return text to false

        val structuralLines = ConfigSecurity.structuralCodeByLine(text)
        val bounds = findSectionBounds(structuralLines, STORAGE_SECTION) ?: return text to false
        val lines = text.lines().toMutableList()

        for (i in bounds.headerIdx + 1 until bounds.endIdx) {
            val trimmed = structuralLines[i].trim()
            val eq = trimmed.indexOf('=')
            if (eq <= 0 || trimmed.substring(0, eq).trim() != STORAGE_DB_PATH_KEY) continue

            val current = parseTomlBasicString(trimmed.substring(eq + 1).trim())
            if (current == null || current !in legacyPaths) return text to false

            lines[i] = """$STORAGE_DB_PATH_KEY = "${escapeToml(databasePath)}""""
            return lines.joinToString("\n") to true
        }

        return text to false
    }

    /** Rewrite only log directories previously generated on shared storage. */
    internal fun retargetLegacyLogPath(
        text: String,
        legacyPaths: List<String>,
        logPath: String,
    ): Pair<String, Boolean> {
        if (logPath in legacyPaths) return text to false

        val structuralLines = ConfigSecurity.structuralCodeByLine(text)
        val bounds = findSectionBounds(structuralLines, LOGGING_SECTION) ?: return text to false
        val lines = text.lines().toMutableList()

        for (i in bounds.headerIdx + 1 until bounds.endIdx) {
            val trimmed = structuralLines[i].trim()
            val eq = trimmed.indexOf('=')
            if (eq <= 0 || trimmed.substring(0, eq).trim() != LOGGING_DIR_KEY) continue

            val current = parseTomlBasicString(trimmed.substring(eq + 1).trim())
            if (current == null || current !in legacyPaths) return text to false

            lines[i] = """$LOGGING_DIR_KEY = "${escapeToml(logPath)}""""
            return lines.joinToString("\n") to true
        }

        return text to false
    }

    /**
     * Inverse of [escapeToml] for a single-line basic string. Returns null for
     * anything this writer never emits, so an unrecognized value is left alone
     * rather than reinterpreted.
     */
    private fun parseTomlBasicString(raw: String): String? {
        if (raw.length < 2 || !raw.startsWith("\"") || !raw.endsWith("\"")) return null

        val body = raw.substring(1, raw.length - 1)
        val decoded = StringBuilder()
        var i = 0
        while (i < body.length) {
            val c = body[i]
            if (c != '\\') {
                if (c == '"') return null
                decoded.append(c)
                i++
                continue
            }
            if (i + 1 >= body.length) return null
            when (val escaped = body[i + 1]) {
                '\\', '"' -> decoded.append(escaped)
                else -> return null
            }
            i += 2
        }

        return decoded.toString()
    }

    private fun removeLegacyDefaultPrompt(
        text: String,
        expectedLines: List<String>,
    ): Pair<String, Boolean> {
        val lines = text.lines().toMutableList()
        val bounds = findSectionBounds(ConfigSecurity.structuralCodeByLine(text), "server")
            ?: return text to false
        val lastStart = bounds.endIdx - expectedLines.size

        if (lastStart < bounds.headerIdx + 1) return text to false

        for (i in bounds.headerIdx + 1..lastStart) {
            val candidate = lines.subList(i, i + expectedLines.size)
            if (candidate.map { it.trim() } == expectedLines) {
                repeat(expectedLines.size) { lines.removeAt(i) }
                return lines.joinToString("\n") to true
            }
        }

        return text to false
    }

    private fun findSectionBounds(structuralLines: List<String>, section: String): SectionBounds? {
        val sectionHeader = "[$section]"
        val headerIdx = structuralLines.indexOfFirst { it.trim() == sectionHeader }
        if (headerIdx == -1) return null

        var endIdx = structuralLines.size
        for (i in headerIdx + 1 until structuralLines.size) {
            val trimmed = structuralLines[i].trim()
            if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
                endIdx = i
                break
            }
        }

        return SectionBounds(headerIdx, endIdx)
    }

    private fun escapeToml(value: String): String =
        value.replace("\\", "\\\\").replace("\"", "\\\"")

    private fun writePrivateConfig(file: File, text: String) {
        val parent = checkNotNull(file.parentFile) { "Canonical config has no parent directory" }
        check(parent.exists() || parent.mkdirs()) { "Failed to create app-private config directory" }
        check(!Files.isSymbolicLink(file.toPath())) { "Refusing to replace a symbolic-link config" }

        val temporary = File(parent, ".${file.name}.tmp")
        check(!Files.isSymbolicLink(temporary.toPath())) { "Refusing to use a symbolic-link temp file" }
        try {
            FileOutputStream(temporary, false).use { output ->
                output.write(text.toByteArray(StandardCharsets.UTF_8))
                output.fd.sync()
            }
            try {
                Files.move(
                    temporary.toPath(),
                    file.toPath(),
                    StandardCopyOption.ATOMIC_MOVE,
                    StandardCopyOption.REPLACE_EXISTING,
                )
            } catch (_: AtomicMoveNotSupportedException) {
                Files.move(
                    temporary.toPath(),
                    file.toPath(),
                    StandardCopyOption.REPLACE_EXISTING,
                )
            }
            // App-private directories provide the primary boundary; retain an
            // owner-only mode if a platform or restored file had broader bits.
            file.setReadable(false, false)
            file.setWritable(false, false)
            check(file.setReadable(true, true) && file.setWritable(true, true)) {
                "Failed to restrict canonical config permissions"
            }
        } finally {
            if (temporary.exists()) temporary.delete()
        }
    }

    private fun removePrivateConfigArtifact(file: File) {
        if (!file.exists() && !Files.isSymbolicLink(file.toPath())) return
        if (Files.isSymbolicLink(file.toPath())) {
            check(file.delete()) { "Failed to remove private config symbolic link" }
            return
        }
        FileOutputStream(file, false).use { output ->
            output.write("# Retired private configuration artifact.\n".toByteArray(StandardCharsets.UTF_8))
            output.fd.sync()
        }
        check(file.delete() || !file.exists()) { "Failed to remove private config artifact" }
    }

    /**
     * Legacy external files are overwritten before deletion. If deletion is
     * denied, only the non-secret tombstone remains on shared storage.
     */
    internal fun removeLegacyConfigArtifacts(vararg legacyConfigFiles: File) {
        val tombstone =
            "# Canonical configuration migrated to app-private storage.\n"
                .toByteArray(StandardCharsets.UTF_8)
        val files = legacyConfigFiles.flatMap { config ->
            listOf(config, File(config.parentFile, "${config.name}.bak"))
        }
        for (file in files) {
            try {
                if (!file.exists() && !Files.isSymbolicLink(file.toPath())) continue
                if (Files.isSymbolicLink(file.toPath())) {
                    file.delete()
                    continue
                }
                if (file.isFile) {
                    FileOutputStream(file, false).use { output ->
                        output.write(tombstone)
                        output.fd.sync()
                    }
                }
                // An overwrite is sufficient for confidentiality; deletion is
                // best-effort because some shared-storage providers deny it.
                file.delete()
            } catch (t: Throwable) {
                // This path is attacker-writable and no longer authoritative.
                // An unsupported artifact type or provider failure must not
                // keep the private server configuration from starting.
                Log.w(TAG, "Failed to retire legacy config artifact (${t.javaClass.simpleName})")
            }
        }
    }

    fun readEffectiveAdminToken(configPath: String): String {
        val environment = System.getenv("PENUMBRA_ADMIN_TOKEN")
        if (environment != null) return ConfigSecurity.requireValidAdminToken(environment)

        val configFile = File(configPath)
        check(!Files.isSymbolicLink(configFile.toPath())) {
            "Refusing to read a symbolic-link canonical config"
        }
        val localConfigFile = File(configFile.parentFile, LOCAL_CONFIG_FILE_NAME)
        if (localConfigFile.exists()) {
            check(!Files.isSymbolicLink(localConfigFile.toPath())) {
                "Refusing to read a symbolic-link local config"
            }
            check(
                ConfigSecurity.readOptionalString(
                    localConfigFile.readText(),
                    "server.admin_token",
                ) == null,
            ) {
                "Android local config must not override server.admin_token"
            }
        }
        return ConfigSecurity.readAdminToken(configFile.readText())
    }

    fun readEffectiveHttpPort(configPath: String): Int {
        val configFile = File(configPath)
        check(!Files.isSymbolicLink(configFile.toPath())) {
            "Refusing to read a symbolic-link canonical config"
        }

        var bindAddress = ConfigSecurity.readOptionalString(
            configFile.readText(),
            "server.http_bind_addr",
        ) ?: "127.0.0.1:8080"
        val localConfigFile = File(configFile.parentFile, LOCAL_CONFIG_FILE_NAME)
        if (localConfigFile.exists()) {
            check(!Files.isSymbolicLink(localConfigFile.toPath())) {
                "Refusing to read a symbolic-link local config"
            }
            ConfigSecurity.readOptionalString(
                localConfigFile.readText(),
                "server.http_bind_addr",
            )?.let { bindAddress = it }
        }

        val port = bindAddress.substringAfterLast(':', "").toIntOrNull()
        check(port != null && port in 1..65535) { "Invalid server HTTP bind address" }
        return port
    }

    fun readEffectiveGrpcPort(configPath: String): Int =
        readEffectiveServerPort(configPath, "server.grpc_bind_addr", "127.0.0.1:9090", "gRPC")

    fun readEffectiveGrpcAuthToken(configPath: String): String {
        val configFile = File(configPath)
        check(!Files.isSymbolicLink(configFile.toPath())) {
            "Refusing to read a symbolic-link canonical config"
        }
        val localConfigFile = File(configFile.parentFile, LOCAL_CONFIG_FILE_NAME)
        val localConfig = if (localConfigFile.exists()) {
            check(!Files.isSymbolicLink(localConfigFile.toPath())) {
                "Refusing to read a symbolic-link local config"
            }
            localConfigFile.readText()
        } else {
            null
        }
        return GrpcAuthTokenResolver.resolve(
            baseConfig = configFile.readText(),
            localConfig = localConfig,
            grpcEnvironment = System.getenv("PENUMBRA_GRPC_AUTH_TOKEN"),
            adminEnvironment = System.getenv("PENUMBRA_ADMIN_TOKEN"),
        )
    }

    private fun readEffectiveServerPort(
        configPath: String,
        key: String,
        defaultValue: String,
        label: String,
    ): Int {
        val configFile = File(configPath)
        check(!Files.isSymbolicLink(configFile.toPath())) {
            "Refusing to read a symbolic-link canonical config"
        }
        var bindAddress = ConfigSecurity.readOptionalString(configFile.readText(), key) ?: defaultValue
        val localConfigFile = File(configFile.parentFile, LOCAL_CONFIG_FILE_NAME)
        if (localConfigFile.exists()) {
            check(!Files.isSymbolicLink(localConfigFile.toPath())) {
                "Refusing to read a symbolic-link local config"
            }
            ConfigSecurity.readOptionalString(localConfigFile.readText(), key)?.let {
                bindAddress = it
            }
        }
        val port = bindAddress.substringAfterLast(':', "").toIntOrNull()
        check(port != null && port in 1..65535) { "Invalid server $label bind address" }
        return port
    }

    fun readEffectiveLanDashboardEnabled(configPath: String): Boolean {
        val configFile = File(configPath)
        check(!Files.isSymbolicLink(configFile.toPath())) {
            "Refusing to read a symbolic-link canonical config"
        }

        var enabled = ConfigSecurity.readOptionalBoolean(
            configFile.readText(),
            "server.lan_dashboard_enabled",
        ) ?: false
        val localConfigFile = File(configFile.parentFile, LOCAL_CONFIG_FILE_NAME)
        if (localConfigFile.exists()) {
            check(!Files.isSymbolicLink(localConfigFile.toPath())) {
                "Refusing to read a symbolic-link local config"
            }
            ConfigSecurity.readOptionalBoolean(
                localConfigFile.readText(),
                "server.lan_dashboard_enabled",
            )?.let { enabled = it }
        }
        return enabled
    }

    /** Best-effort extraction of advertised metadata from the config. */
    data class AdvertisedConfig(
        val displayName: String,
        val httpPort: Int,
        val lanDashboardEnabled: Boolean,
    )

    fun readAdvertisedConfig(configPath: String): AdvertisedConfig {
        val defaults = AdvertisedConfig(
            displayName = "Ai Pin",
            httpPort = 8080,
            lanDashboardEnabled = false,
        )
        val text = try {
            File(configPath).readText()
        } catch (t: Throwable) {
            Log.w(TAG, "Failed to read canonical config for advertisement", t)
            return defaults
        }

        // Tiny, intentionally-naive TOML scraper: we only need two scalars and
        // we control the file format. Comments and tables are tolerated;
        // multi-line strings, inline tables, and arrays of tables are not used here.
        var displayName: String? = null
        var httpPort: Int? = null

        for (line in ConfigSecurity.structuralCodeByLine(text).map(String::trim)) {
            if (line.isEmpty() || line.startsWith('[')) continue
            val eq = line.indexOf('=')
            if (eq <= 0) continue
            val key = line.substring(0, eq).trim()
            val value = line.substring(eq + 1).trim().trim('"', '\'')
            when (key) {
                "display_name" -> if (value.isNotEmpty()) displayName = value
                "http_bind_addr" -> {
                    val portStr = value.substringAfterLast(':', "")
                    portStr.toIntOrNull()?.let { httpPort = it }
                }
            }
        }

        return AdvertisedConfig(
            displayName = displayName ?: defaults.displayName,
            httpPort = runCatching { readEffectiveHttpPort(configPath) }
                .getOrDefault(httpPort ?: defaults.httpPort),
            lanDashboardEnabled = runCatching {
                readEffectiveLanDashboardEnabled(configPath)
            }.getOrDefault(defaults.lanDashboardEnabled),
        )
    }

    /**
     * Read the DashScope API key for the Codex model-provider from the config file.
     * Returns null if not configured. The key is never logged.
     */
    fun readEffectiveDashScopeApiKey(configPath: String): String? {
        val configFile = File(configPath)
        check(!Files.isSymbolicLink(configFile.toPath())) {
            "Refusing to read a symbolic-link canonical config"
        }

        // Check environment variable first (for testing/override)
        System.getenv("DASHSCOPE_API_KEY")?.takeIf { it.isNotEmpty() }?.let { return it }

        // Read from config file [llm.codex] section
        val localConfigFile = File(configFile.parentFile, LOCAL_CONFIG_FILE_NAME)
        if (localConfigFile.exists()) {
            check(!Files.isSymbolicLink(localConfigFile.toPath())) {
                "Refusing to read a symbolic-link local config"
            }
            ConfigSecurity.readOptionalString(
                localConfigFile.readText(),
                "llm.codex.api_key",
            )?.takeIf { it.isNotEmpty() }?.let { return it }
        }

        // Check external storage for local config (for initial setup without root)
        val externalLocalConfig = File(ensurePersistentRoot(), LOCAL_CONFIG_FILE_NAME)
        if (externalLocalConfig.exists()) {
            check(!Files.isSymbolicLink(externalLocalConfig.toPath())) {
                "Refusing to read a symbolic-link external local config"
            }
            ConfigSecurity.readOptionalString(
                externalLocalConfig.readText(),
                "llm.codex.api_key",
            )?.takeIf { it.isNotEmpty() }?.let { return it }
        }

        return ConfigSecurity.readOptionalString(
            configFile.readText(),
            "llm.codex.api_key",
        )?.takeIf { it.isNotEmpty() }
    }
}
