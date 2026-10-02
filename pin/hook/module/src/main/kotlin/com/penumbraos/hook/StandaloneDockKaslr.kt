package com.penumbraos.hook

import java.io.BufferedReader
import java.io.File
import java.util.zip.ZipFile

internal class StandaloneDockKaslrException(message: String) : Exception(message)

internal data class StandaloneDockKaslrAnchor(
    val role: String,
    val symbol: String,
    val offset: ULong,
    val linkAddress: ULong,
    val runtimeAddress: ULong,
    val slide: ULong,
    val reportLine: Int,
)

internal data class StandaloneDockKaslrResult(
    val runtimeTextBase: ULong,
    val slide: ULong,
    val anchors: List<StandaloneDockKaslrAnchor>,
)

/**
 * Streaming port of the vendored Ghostlock current-boot bugreport parser.
 * Archived logcat ZIP members are never considered.
 */
internal object StandaloneDockKaslr {
    private const val MAX_CAPTURED_KERNEL_LINES = 200_000
    private val kaslrAlignment = 0x200000UL
    private val kimageMin = 0xffffff8000000000UL
    private val kimageMax = 0xffffffc000000000UL
    private val symbolLine = Regex("^([0-9a-fA-F]{16})\\s+\\S\\s+(\\S+)$")
    private val rolePattern = Regex(
        "\\b(pc|lr)\\s*:\\s*([A-Za-z0-9_.$]+)\\+0x([0-9a-fA-F]+)/0x[0-9a-fA-F]+",
        RegexOption.IGNORE_CASE,
    )
    private val dumpHeaderPattern = Regex(
        "\\b(PC|LR)\\s*:\\s*0x([0-9a-fA-F]{16}):",
    )
    private val stackWordsPattern = Regex(
        "(?:^|[:\\]])\\s*[0-9a-fA-F]{4}\\s+" +
            "((?:[0-9a-fA-F]{8}\\s+){7}[0-9a-fA-F]{8})(?:\\s|$)",
    )

    fun derive(
        zip: File,
        symbolsText: String,
        expectedBootId: String?,
        expectedSerial: String,
        expectedFingerprint: String,
    ): StandaloneDockKaslrResult {
        val symbols = loadSymbols(symbolsText)
        val evidence = readCurrentKernelEvidence(
            zip,
            expectedBootId,
            expectedSerial,
            expectedFingerprint,
        )
        val anchors = mutableListOf<StandaloneDockKaslrAnchor>()

        for (block in warnBlocks(evidence)) {
            val roles = linkedMapOf<String, Pair<String, ULong>>()
            val headers = mutableMapOf<String, ULong>()
            for (line in block.lines) {
                rolePattern.find(line.text)?.let { match ->
                    val role = match.groupValues[1].uppercase()
                    roles.putIfAbsent(
                        role,
                        match.groupValues[2] to match.groupValues[3].toULong(16),
                    )
                }
                dumpHeaderPattern.find(line.text)?.let { match ->
                    headers[match.groupValues[1].uppercase()] =
                        match.groupValues[2].toULong(16)
                }
            }

            val qwords = stackQwords(block.lines)
            for (role in listOf("PC", "LR")) {
                val (symbol, offset) = roles[role] ?: continue
                val header = headers[role] ?: continue
                val linkAddress = symbols[symbol] ?: continue
                val runtime = header + 0x40UL
                if (runtime !in qwords) {
                    throw StandaloneDockKaslrException(
                        "$role raw register is absent from the WARN stack frame",
                    )
                }
                val slide = validSlide(runtime, linkAddress + offset)
                    ?: throw StandaloneDockKaslrException(
                        "$role anchor $symbol yields an invalid slide",
                    )
                anchors += StandaloneDockKaslrAnchor(
                    role = role,
                    symbol = symbol,
                    offset = offset,
                    linkAddress = linkAddress,
                    runtimeAddress = runtime,
                    slide = slide,
                    reportLine = block.lines.first().number,
                )
            }
        }

        if (anchors.size < 2) {
            throw StandaloneDockKaslrException("fewer than two usable WARN anchors")
        }
        if (anchors.map { it.symbol }.toSet().size < 2) {
            throw StandaloneDockKaslrException("WARN anchors do not cover two symbols")
        }
        val slides = anchors.map { it.slide }.toSet()
        if (slides.size != 1) {
            throw StandaloneDockKaslrException("WARN anchors disagree on the KASLR slide")
        }
        val slide = slides.single()
        val runtimeText = symbols.getValue("_text") + slide
        if (runtimeText % 0x1000UL != 0UL) {
            throw StandaloneDockKaslrException("derived runtime text is not page aligned")
        }
        return StandaloneDockKaslrResult(runtimeText, slide, anchors)
    }

    private fun loadSymbols(text: String): Map<String, ULong> {
        val symbols = mutableMapOf<String, ULong>()
        val ambiguous = mutableSetOf<String>()
        for (line in text.lineSequence()) {
            val match = symbolLine.matchEntire(line) ?: continue
            val name = match.groupValues[2]
            val address = match.groupValues[1].toULong(16)
            val previous = symbols[name]
            if (previous != null && previous != address) {
                ambiguous += name
            } else if (name !in ambiguous) {
                symbols[name] = address
            }
        }
        ambiguous.forEach(symbols::remove)
        if ("_text" !in symbols) {
            throw StandaloneDockKaslrException("symbols do not contain _text")
        }
        return symbols
    }

    private data class NumberedLine(val number: Int, val text: String)
    private data class WarnBlock(val lines: List<NumberedLine>)

    private fun readCurrentKernelEvidence(
        zip: File,
        expectedBootId: String?,
        expectedSerial: String,
        expectedFingerprint: String,
    ): List<NumberedLine> = try {
        ZipFile(zip).use { archive ->
            val reports = mutableListOf<java.util.zip.ZipEntry>()
            val entries = archive.entries()
            while (entries.hasMoreElements()) {
                val entry = entries.nextElement()
                val name = entry.name.trimEnd('/')
                if ('/' !in name && name.startsWith("bugreport-") && name.endsWith(".txt")) {
                    reports += entry
                }
            }
            if (reports.size != 1) {
                throw StandaloneDockKaslrException("expected one root bugreport text member")
            }
            archive.getInputStream(reports.single()).bufferedReader().use { reader ->
                scanReport(
                    reader,
                    expectedBootId,
                    expectedSerial,
                    expectedFingerprint,
                )
            }
        }
    } catch (error: StandaloneDockKaslrException) {
        throw error
    } catch (error: Exception) {
        throw StandaloneDockKaslrException("cannot read current bugreport")
    }

    private fun scanReport(
        reader: BufferedReader,
        expectedBootId: String?,
        expectedSerial: String,
        expectedFingerprint: String,
    ): List<NumberedLine> {
        val kernelLog = mutableListOf<NumberedLine>()
        val systemLog = mutableListOf<NumberedLine>()
        val dedicatedKernel = mutableListOf<NumberedLine>()
        var inKernelLog = false
        var inSystemLog = false
        var inDedicatedKernel = false
        var sawDedicatedKernel = false
        var sawSerial = false
        var sawFingerprint = false
        var sawAnyBootId = false
        var sawExpectedBootId = false
        var lineNumber = 0

        while (true) {
            val line = reader.readLine() ?: break
            lineNumber++
            if (line.contains("androidboot.serialno=$expectedSerial")) sawSerial = true
            if (line == "Build fingerprint: '$expectedFingerprint'") sawFingerprint = true
            if (line.contains("linuxBootId=")) {
                sawAnyBootId = true
                if (expectedBootId != null && line.contains("linuxBootId=$expectedBootId")) {
                    sawExpectedBootId = true
                }
            }

            if (line.startsWith("------ ")) {
                inKernelLog = line.startsWith("------ KERNEL LOG (dmesg) ------")
                inSystemLog = line.startsWith("------ SYSTEM LOG (")
                inDedicatedKernel = false
                continue
            }
            val numbered = NumberedLine(lineNumber, line)
            if (inKernelLog) boundedAdd(kernelLog, numbered)
            if (inSystemLog) {
                boundedAdd(systemLog, numbered)
                if (line.trim() == "--------- beginning of kernel") {
                    sawDedicatedKernel = true
                    inDedicatedKernel = true
                    continue
                }
                if (inDedicatedKernel && line.startsWith("--------- beginning of ")) {
                    inDedicatedKernel = false
                    continue
                }
                if (inDedicatedKernel) boundedAdd(dedicatedKernel, numbered)
            }
        }

        if (!sawSerial) throw StandaloneDockKaslrException("bugreport serial mismatch")
        if (!sawFingerprint) throw StandaloneDockKaslrException("bugreport fingerprint mismatch")
        if (expectedBootId != null && sawAnyBootId && !sawExpectedBootId) {
            throw StandaloneDockKaslrException("bugreport boot mismatch")
        }
        return when {
            kernelLog.isNotEmpty() -> kernelLog
            sawDedicatedKernel && dedicatedKernel.isNotEmpty() -> dedicatedKernel
            systemLog.isNotEmpty() -> systemLog
            else -> throw StandaloneDockKaslrException("current kernel log is absent")
        }
    }

    private fun boundedAdd(lines: MutableList<NumberedLine>, line: NumberedLine) {
        if (lines.size >= MAX_CAPTURED_KERNEL_LINES) {
            throw StandaloneDockKaslrException("current kernel log exceeds its bound")
        }
        lines += line
    }

    private fun warnBlocks(lines: List<NumberedLine>): List<WarnBlock> {
        val blocks = mutableListOf<WarnBlock>()
        var index = 0
        while (index < lines.size) {
            if (!lines[index].text.contains("WARNING: CPU:")) {
                index++
                continue
            }
            val start = index
            var end = minOf(lines.size, start + 160)
            for (cursor in start until end) {
                if (lines[cursor].text.contains("---[ end trace")) {
                    end = cursor + 1
                    break
                }
            }
            blocks += WarnBlock(lines.subList(start, end))
            index = end
        }
        return blocks
    }

    private fun stackQwords(block: List<NumberedLine>): Set<ULong> {
        val qwords = mutableSetOf<ULong>()
        var inStackDump = false
        for (line in block) {
            if (Regex("\\bSP\\s*:\\s*0x[0-9a-fA-F]{16}:").containsMatchIn(line.text)) {
                inStackDump = true
                continue
            }
            if (!inStackDump) continue
            if (line.text.contains("Call trace:") || line.text.contains("---[ end trace")) break
            val match = stackWordsPattern.find(line.text) ?: continue
            val words = match.groupValues[1].trim().split(Regex("\\s+"))
                .map { it.toULong(16) }
            for (index in words.indices step 2) {
                qwords += words[index] or (words[index + 1] shl 32)
            }
        }
        return qwords
    }

    private fun validSlide(runtime: ULong, linkRuntime: ULong): ULong? {
        if (runtime < kimageMin || runtime >= kimageMax || runtime < linkRuntime) return null
        val slide = runtime - linkRuntime
        if (slide % kaslrAlignment != 0UL) return null
        val runtimeBase = kimageMin + slide
        if (runtimeBase < kimageMin || runtimeBase >= kimageMax) return null
        return slide
    }
}
