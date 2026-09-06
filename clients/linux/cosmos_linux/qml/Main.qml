import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

ApplicationWindow {
    id: window
    title: "Cosmos"
    visible: true
    width: 760; height: 600
    minimumWidth: 560; minimumHeight: 460
    color: "#080E12"
    palette.text: "#F2F7F8"
    palette.windowText: "#F2F7F8"
    palette.base: "#111B20"
    palette.button: "#111B20"
    palette.buttonText: "#F2F7F8"
    palette.highlight: "#27E6DF"
    palette.highlightedText: "#030809"
    font.pixelSize: 14

    // One redacted snapshot drives every view; nothing here holds credentials.
    property var s: backend.state
    property bool motionEnabled: !s.reducedMotion && window.active && window.visible

    Shortcut { sequence: "Escape"; onActivated: backend.hideWindow() }
    Shortcut { sequence: "Ctrl+Q"; onActivated: backend.quit() }
    Shortcut {
        sequence: "Ctrl+L"
        onActivated: if (views.item && views.item.focusPrimary) views.item.focusPrimary()
    }

    Image {
        anchors.left: parent.left; anchors.right: parent.right; anchors.bottom: parent.bottom
        height: width / 3
        source: "../assets/nebula-bottom.png"
        opacity: 0.22
        fillMode: Image.PreserveAspectFit
        Accessible.ignored: true
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 22
        spacing: 12

        RowLayout {
            spacing: 12
            Image {
                source: "../assets/cosmos-logo.png"
                Layout.preferredWidth: 32; Layout.preferredHeight: 32
                Accessible.ignored: true
            }
            Label { text: "Cosmos"; color: "#F2F7F8"; font.pixelSize: 22; font.bold: true }
            Item { Layout.fillWidth: true }
            Rectangle {
                id: statusPill
                radius: height / 2
                color: "#111B20"
                border.width: 1
                border.color: s.connected ? "#27E6DF" : (s.phase === "blocked" ? "#FFAC9C" : "#33464D")
                implicitHeight: 28
                implicitWidth: statusLabel.implicitWidth + 28
                Accessible.role: Accessible.StatusBar
                Accessible.name: statusLabel.text
                Label {
                    id: statusLabel
                    anchors.centerIn: parent
                    text: (s.preview ? "Preview · " : "") + s.statusText
                    color: s.phase === "blocked" ? "#FFAC9C" : "#A4B7BE"
                    font.pixelSize: 12
                    elide: Text.ElideRight
                    maximumLineCount: 1
                }
            }
        }

        Loader {
            id: views
            Layout.fillWidth: true
            Layout.fillHeight: true
            source: s.view === "setup" ? "SetupView.qml" : (s.view === "approval" ? "ApprovalView.qml" : "ConnectedView.qml")
        }

        RowLayout {
            Label {
                text: s.view === "connected"
                    ? "Ctrl+L: ask    Enter: send    Esc: hide    Ctrl+Q: quit"
                    : "Ctrl+L: focus    Esc: hide    Ctrl+Q: quit"
                color: "#A4B7BE"; font.pixelSize: 12
            }
            Item { Layout.fillWidth: true }
            CheckBox {
                id: motion
                text: "Reduce motion"
                checked: s.reducedMotion
                onToggled: backend.setReducedMotion(checked)
                font.pixelSize: 12
                palette.windowText: "#A4B7BE"
            }
        }
    }
}
