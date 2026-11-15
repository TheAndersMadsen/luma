package com.penumbraos.hook

/**
 * INFERRED layout, using stock HomeContentView.<init>'s LabelView/font/alignment
 * API. This child belongs to HomeView's existing projected surface. It cannot
 * start the laser, create a mesh, or intercept stock touches. Main thread only.
 */
internal class LauncherGestureFeedback(cl: ClassLoader) {
    private val view = cl.loadClass("humane.ui.View")
    private val labelType = cl.loadClass("humane.ui.LabelView")
    private val rect = cl.loadClass("humane.ui.Rect")
    private val mutableRect = cl.loadClass("humane.ui.MutableRect")
    private val floatType = Float::class.javaPrimitiveType!!
    private val label = labelType.getConstructor().newInstance()
    private var parent: Any? = null

    init {
        val theme = cl.loadClass("humane.ui.Theme")
        val font = theme.getMethod("labelEmpFont").invoke(theme.getMethod("current").invoke(null))
        labelType.getMethod("setFont", cl.loadClass("humane.ui.Font")).invoke(label, font)
        val horizontal = cl.loadClass("humane.ui.TextLayout\$Alignment")
        val vertical = cl.loadClass("humane.ui.Layout\$VerticalAlignment")
        labelType.getMethod("setAlignment", horizontal, vertical).invoke(label,
            requireNotNull(horizontal.enumConstants).single { it.toString() == "CENTER" },
            requireNotNull(vertical.enumConstants).single { it.toString() == "MIDDLE" })
        view.getMethod("setIgnoresTouchEvents", Boolean::class.javaPrimitiveType).invoke(label, true)
        val color = cl.loadClass("humane.ui.Color")
        view.getMethod("setBackgroundColor", color).invoke(label, color.getField("BLACK").get(null))
        hide()
    }

    fun show(home: Any, text: String) {
        if (parent !== home) {
            view.getMethod("removeFromParentView").invoke(label)
            view.getMethod("addChildView", view).invoke(home, label)
            parent = home
        }
        val bounds = mutableRect.getConstructor().newInstance()
        view.getMethod("getBounds", mutableRect).invoke(home, bounds)
        val width = rect.getMethod("width").invoke(bounds) as Float
        val height = rect.getMethod("height").invoke(bounds) as Float
        if (width < 160 || height < 160) { hide(); return }
        val frame = rect.getConstructor(floatType, floatType, floatType, floatType)
            .newInstance(40f, height - 140f, width - 80f, 100f)
        view.getMethod("setFrame", rect).invoke(label, frame)
        labelType.getMethod("setString", String::class.java).invoke(label, text)
        view.getMethod("setShowing", Boolean::class.javaPrimitiveType).invoke(label, true)
    }

    fun hide() { view.getMethod("setShowing", Boolean::class.javaPrimitiveType).invoke(label, false) }
}
