package com.penumbraos.hook

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import dev.luma.gestures.ClipPresentation
import dev.luma.gestures.ClipPublisherMark
import dev.luma.gestures.ClipVisualStage
import java.io.ByteArrayOutputStream
import java.lang.reflect.Proxy

/**
 * Stock ControlView.setupTouchHandling -> Button2.pressedStateDidChange
 * supplies native pinch press state. A dedicated full-surface button consumes it
 * only during an explicit Clip session; Home's buttons cannot also activate.
 * The publisher/title layout is INFERRED and uses the existing native mesh.
 */
internal class LauncherClipView(cl: ClassLoader, context: Context, onPress: (Boolean) -> Unit) {
    private val view = cl.loadClass("humane.ui.View")
    private val buttonType = cl.loadClass("humane.ui.Button2")
    private val labelType = cl.loadClass("humane.ui.LabelView")
    private val imageType = cl.loadClass("humane.ui.Image")
    private val imageViewType = cl.loadClass("humane.ui.ImageView")
    private val rect = cl.loadClass("humane.ui.Rect")
    private val mutableRect = cl.loadClass("humane.ui.MutableRect")
    private val floatType = Float::class.javaPrimitiveType!!
    private val boolType = Boolean::class.javaPrimitiveType!!
    private val preset = cl.loadClass("humane.ui.Button2\$PresetStyle")
    private val surface = view.getConstructor().newInstance()
    private val button = buttonType.getConstructor(preset).newInstance(requireNotNull(preset.enumConstants).single { it.toString() == "INVISIBLE" })
    private val label = labelType.getConstructor().newInstance()
    private val mark = imageViewType.getConstructor().newInstance()
    private val color = cl.loadClass("humane.ui.Color")
    private val resources = context.packageManager.getResourcesForApplication("com.penumbraos.hook")
    private var markKey: Pair<ClipPublisherMark, String>? = null
    private var parent: Any? = null

    init {
        val handler = cl.loadClass("humane.ui.Button2\$ActionHandler")
        val proxy = Proxy.newProxyInstance(cl, arrayOf(handler)) { instance, method, args ->
            when (method.name) {
                "handlePressedStateChange" -> { onPress(buttonType.getMethod("isPressed").invoke(button) == true); null }
                "hashCode" -> System.identityHashCode(instance)
                "equals" -> instance === args?.firstOrNull()
                "toString" -> "LumaClipPressHandler"
                else -> null
            }
        }
        buttonType.getMethod("setActionHandler", handler).invoke(button, proxy)
        buttonType.getMethod("setFocusedMagnifyScale", floatType).invoke(button, 1f)
        buttonType.getMethod("setPressedMagnifyScale", floatType).invoke(button, 1f)
        view.getMethod("setIgnoresTouchEvents", boolType).invoke(label, true)
        view.getMethod("setIgnoresTouchEvents", boolType).invoke(mark, true)
        val theme = cl.loadClass("humane.ui.Theme")
        labelType.getMethod("setFont", cl.loadClass("humane.ui.Font")).invoke(label,
            theme.getMethod("labelEmpFont").invoke(theme.getMethod("current").invoke(null)))
        labelType.getMethod("setMaxNumberOfLines", Int::class.javaPrimitiveType).invoke(label, 7)
        val horizontal = cl.loadClass("humane.ui.TextLayout\$Alignment")
        val vertical = cl.loadClass("humane.ui.Layout\$VerticalAlignment")
        labelType.getMethod("setAlignment", horizontal, vertical).invoke(label,
            requireNotNull(horizontal.enumConstants).single { it.toString() == "CENTER" },
            requireNotNull(vertical.enumConstants).single { it.toString() == "TOP" })
        view.getMethod("addChildView", view).invoke(surface, button)
        view.getMethod("addChildView", view).invoke(surface, label)
        view.getMethod("addChildView", view).invoke(surface, mark)
    }

    fun show(home: Any, presentation: ClipPresentation?, opaque: Boolean) {
        if (parent !== home) {
            view.getMethod("removeFromParentView").invoke(surface)
            view.getMethod("addChildView", view).invoke(home, surface)
            parent = home
        }
        val bounds = mutableRect.getConstructor().newInstance()
        view.getMethod("getBounds", mutableRect).invoke(home, bounds)
        val width = rect.getMethod("width").invoke(bounds) as Float
        val height = rect.getMethod("height").invoke(bounds) as Float
        view.getMethod("setFrame", rect).invoke(surface, bounds)
        view.getMethod("setFrame", rect).invoke(button, bounds)
        // INFERRED from the supplied demo's publisher-only and title frames:
        // keep the small circled mark above-left of the title in both phases.
        // Final projection coordinates/font sizing require the physical Pin.
        val markSize = minOf(width, height) * .09f
        view.getMethod("setFrame", rect).invoke(mark, rect.getConstructor(floatType, floatType, floatType, floatType)
            .newInstance(width * .24f, height * .30f, markSize, markSize))
        view.getMethod("setFrame", rect).invoke(label, rect.getConstructor(floatType, floatType, floatType, floatType)
            .newInstance(width * .30f, height * .42f, width * .58f, height * .5f))
        labelType.getMethod("setMaxNumberOfLines", Int::class.javaPrimitiveType).invoke(label,
            if (presentation?.stage == ClipVisualStage.DETAILS) 7 else 4)
        labelType.getMethod("setString", String::class.java).invoke(label, presentation?.text ?: "")
        view.getMethod("setShowing", boolType).invoke(mark, presentation != null)
        if (presentation != null) updateMark(presentation)
        // Keep Clip's black surface independent of the stock button animations
        // (Button2.focusProgressDidChange / pressedProgressDidChange).
        view.getMethod("setBackgroundColor", color).invoke(surface, color.getField(if (opaque) "BLACK" else "CLEAR").get(null))
        view.getMethod("setShowing", boolType).invoke(surface, true)
    }

    private fun updateMark(presentation: ClipPresentation) {
        val key = presentation.publisherMark to presentation.publisherInitial
        if (key == markKey) return
        // Stock Image(byte[]) decodes a local bitmap and ImageView uses FIT_ASPECT.
        // No network image, downloaded SVG, HTML or article-controlled path.
        val bitmap = Bitmap.createBitmap(128, 128, Bitmap.Config.ARGB_8888)
        try {
            val canvas = Canvas(bitmap)
            if (presentation.publisherMark == ClipPublisherMark.NEW_YORK_TIMES) {
                val drawable = requireNotNull(resources.getDrawable(R.drawable.luma_clip_nyt, null))
                drawable.setBounds(0, 0, 128, 128)
                drawable.draw(canvas)
            } else {
                val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = android.graphics.Color.WHITE; style = Paint.Style.STROKE; strokeWidth = 5f }
                canvas.drawCircle(64f, 64f, 57f, paint)
                paint.style = Paint.Style.FILL; paint.textSize = 68f; paint.typeface = Typeface.DEFAULT_BOLD; paint.textAlign = Paint.Align.CENTER
                canvas.drawText(presentation.publisherInitial, 64f, 64f - (paint.ascent() + paint.descent()) / 2f, paint)
            }
            val bytes = ByteArrayOutputStream().also { check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) }.toByteArray()
            imageViewType.getMethod("setImage", imageType).invoke(mark, imageType.getConstructor(ByteArray::class.java).newInstance(bytes))
            markKey = key
        } finally { bitmap.recycle() }
    }

    fun hide() { view.getMethod("setShowing", boolType).invoke(surface, false) }
}
