import QtQuick

Canvas {
    id: root
    property string phase: "idle"
    property bool motionEnabled: true
    property real audioLevel: -1
    property real tick: 0
    implicitWidth: 48
    implicitHeight: 36
    onPhaseChanged: requestPaint()
    onAudioLevelChanged: requestPaint()
    onMotionEnabledChanged: requestPaint()
    onWidthChanged: requestPaint()
    onHeightChanged: requestPaint()
    Timer {
        interval: 33
        repeat: true
        running: root.visible && root.motionEnabled && root.phase !== "idle" && root.phase !== "error"
        onTriggered: { root.tick = (root.tick + 0.173) % (2 * Math.PI); root.requestPaint() }
    }
    onPaint: {
        const ctx = getContext("2d")
        ctx.clearRect(0, 0, width, height)
        ctx.fillStyle = phase === "error" ? "#FFAC9C" : (phase === "idle" ? "#FFFFFF" : "#58F4F1")
        const heights = [0.22, 0.56, 0.82, 1.0, 0.82, 0.56, 0.22]
        for (let i = 0; i < 7; i++) {
            let energy = 0.82
            if (motionEnabled && phase !== "idle" && phase !== "error")
                energy = isFinite(audioLevel) && audioLevel >= 0 ? 0.3 + 0.7 * Math.min(1, audioLevel) : 0.64 + 0.30 * Math.sin(tick + i * 0.62)
            const w = width / 13
            const h = Math.max(3, height * heights[i] * energy)
            const x = i * width / 7 + (width / 7 - w) / 2
            const y = (height - h) / 2
            const r = Math.min(w / 2, h / 2)
            ctx.beginPath()
            ctx.moveTo(x + r, y)
            ctx.lineTo(x + w - r, y)
            ctx.quadraticCurveTo(x + w, y, x + w, y + r)
            ctx.lineTo(x + w, y + h - r)
            ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
            ctx.lineTo(x + r, y + h)
            ctx.quadraticCurveTo(x, y + h, x, y + h - r)
            ctx.lineTo(x, y + r)
            ctx.quadraticCurveTo(x, y, x + r, y)
            ctx.closePath()
            ctx.fill()
        }
    }
}
