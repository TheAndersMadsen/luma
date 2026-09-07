import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// One calm, tiling-friendly window. Graphite from the kit tokens, cyan only
// as the accent, the nebula only behind welcome and empty states. Every
// snapshot the backend publishes is presentation-safe.
ApplicationWindow {
    id: window
    title: S.APP_NAME
    visible: true
    width: 760; height: 620
    minimumWidth: 560; minimumHeight: 480
    color: theme.background
    palette.text: theme.primary
    palette.windowText: theme.primary
    palette.base: theme.surface
    palette.button: theme.surface
    palette.buttonText: theme.primary
    palette.highlight: theme.accent
    palette.highlightedText: theme.panel
    palette.placeholderText: theme.secondary
    font.pixelSize: 14

    property var s: backend.state
    property bool motionEnabled: !s.reducedMotion && window.active && window.visible
    property int motionMs: s.reducedMotion ? 0 : theme.motionMs
    property bool welcome: s.view !== "connected"
    property bool emptyState: s.view === "connected" && s.display == null && s.speech == null && s.sentText.length === 0
    // Set while a menu is open so Escape dismisses the menu instead of the window.
    property bool popupOpen: false

    // Closing the window never cancels a task; the turn continues and the icon
    // shows Working. While a ceremony is on screen it owns the keyboard — a
    // modal popup takes every key, including these — so Enter and Escape reach
    // the ceremony and nothing here.
    Shortcut { sequence: "Escape"; enabled: !window.popupOpen; onActivated: backend.hideWindow() }
    // "Cancel task" is explicit and separate from closing the window.
    Shortcut { sequence: "Ctrl+."; enabled: s.canCancelTask; onActivated: backend.cancelTask() }
    Shortcut { sequence: "Ctrl+Q"; onActivated: backend.quit() }
    Shortcut { sequence: "Ctrl+L"; onActivated: if (views.item && views.item.focusPrimary) views.item.focusPrimary() }
    Shortcut {
        sequences: ["Ctrl+Return", "Ctrl+Enter"]
        onActivated: if (views.item && views.item.sendFromAnywhere) views.item.sendFromAnywhere()
    }

    Image {
        anchors.left: parent.left; anchors.right: parent.right; anchors.bottom: parent.bottom
        height: width / 3
        source: "../assets/nebula-bottom.png"
        opacity: (window.welcome || window.emptyState) ? theme.nebulaOpacity : 0
        visible: opacity > 0
        fillMode: Image.PreserveAspectFit
        Accessible.ignored: true
        Behavior on opacity { NumberAnimation { duration: window.motionMs * 2; easing.type: Easing.OutCubic } }
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 22
        spacing: 12

        RowLayout {
            spacing: 12
            Layout.minimumHeight: 44
            Image {
                source: "../assets/cosmos-logo.png"
                Layout.preferredWidth: 32; Layout.preferredHeight: 32
                Accessible.ignored: true
            }
            Label { text: S.APP_NAME; color: theme.primary; font.pixelSize: 22; font.weight: Font.DemiBold }
            Label {
                visible: s.preview
                text: S.PREVIEW
                color: theme.secondary; font.pixelSize: 12
            }
            Item { Layout.fillWidth: true }
            CosmosWaveform {
                visible: !window.welcome
                Layout.preferredWidth: 40; Layout.preferredHeight: 28
                phase: s.waveformPhase
                motionEnabled: window.motionEnabled
            }
            PresenceLine {
                visible: !window.welcome
                Layout.preferredWidth: Math.min(implicitWidth, 360)
                title: s.presenceTitle
                detail: s.presenceDetail
                tone: s.waveformPhase
            }
        }

        Loader {
            id: views
            Layout.fillWidth: true
            Layout.fillHeight: true
            source: s.view === "setup" ? "SetupView.qml" : (s.view === "approval" ? "ApprovalView.qml" : "ConnectedView.qml")
            opacity: status === Loader.Ready ? 1 : 0
            Behavior on opacity { NumberAnimation { duration: window.motionMs; easing.type: Easing.OutCubic } }
        }

        RowLayout {
            Label {
                text: s.view === "connected" ? S.SHORTCUTS_CONNECTED : S.SHORTCUTS_SETUP
                color: theme.secondary; font.pixelSize: 12
                elide: Text.ElideRight
                Layout.fillWidth: true
            }
            CheckBox {
                id: motion
                text: S.REDUCE_MOTION
                checked: s.reducedMotion
                onToggled: backend.setReducedMotion(checked)
                font.pixelSize: 12
                palette.windowText: theme.secondary
                Accessible.name: S.REDUCE_MOTION
                indicator: Rectangle {
                    implicitWidth: 16; implicitHeight: 16
                    x: motion.leftPadding
                    y: parent.height / 2 - height / 2
                    radius: 4
                    color: motion.checked ? theme.accent : theme.surface
                    border.color: motion.activeFocus ? theme.accent : theme.border
                    border.width: motion.activeFocus ? 2 : 1
                }
                contentItem: Text {
                    text: motion.text
                    color: theme.secondary
                    font: motion.font
                    leftPadding: motion.indicator.width + 6
                    verticalAlignment: Text.AlignVCenter
                }
            }
        }
    }
}
