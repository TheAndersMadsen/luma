package com.penumbraos.systeminjector

import android.util.Xml
import org.xmlpull.v1.XmlPullParser
import org.xmlpull.v1.XmlSerializer
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.nio.charset.StandardCharsets

/**
 * Converts Android Binary XML (ABX) format to plain text XML.
 * Uses hidden API Xml.newBinaryPullParser() available on Android 12+.
 */
fun abx2xml(abxData: ByteArray): String {
    @Suppress("UNCHECKED_CAST")
    val parser: XmlPullParser = Xml::class.java
        .getMethod("newBinaryPullParser")
        .invoke(null) as XmlPullParser
    val serializer: XmlSerializer = Xml.newSerializer()

    val os = ByteArrayOutputStream()
    parser.setInput(ByteArrayInputStream(abxData), StandardCharsets.UTF_8.name())
    serializer.setOutput(os, StandardCharsets.UTF_8.name())
    serializer.setFeature("http://xmlpull.org/v1/doc/features.html#indent-output", true)
    Xml::class.java
        .getMethod("copy", XmlPullParser::class.java, XmlSerializer::class.java)
        .invoke(null, parser, serializer)

    serializer.flush()
    return os.toString(StandardCharsets.UTF_8.name())
}
