import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// First run, step one: one sentence on what this does and one button.
// Changing the Center address sits behind Details.
Item {
    id: root
    property var s: backend.state
    property bool working: s.phase === "preparing" || (s.busy && !s.editingServer)

    function focusPrimary() {
        if (serverField.visible) serverField.forceActiveFocus()
        else setupButton.forceActiveFocus()
    }
    function sendFromAnywhere() {
        if (setupButton.enabled) setupButton.clicked()
    }

    ColumnLayout {
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.margins: 6
        spacing: 16

        Label {
            text: S.SETUP_TITLE
            color: theme.primary
            font.pixelSize: 26
            font.weight: Font.DemiBold
            Accessible.role: Accessible.Heading
        }
        Label {
            Layout.fillWidth: true
            Layout.maximumWidth: theme.maxLineWidth
            wrapMode: Text.Wrap
            color: theme.secondary
            font.pixelSize: theme.body - 2
            lineHeight: 1.25
            text: S.SETUP_BODY
        }

        RowLayout {
            spacing: 10
            visible: !s.editingServer
            Label { text: S.SERVER_LABEL; color: theme.secondary; font.pixelSize: 13 }
            Label { text: s.serverHost; color: theme.primary; font.pixelSize: 14 }
        }

        ColumnLayout {
            visible: s.editingServer
            Layout.fillWidth: true
            Layout.maximumWidth: theme.maxLineWidth
            spacing: 8
            Label { text: S.SERVER_LABEL; color: theme.secondary; font.pixelSize: 13 }
            TextField {
                id: serverField
                Layout.fillWidth: true
                Layout.preferredHeight: 42
                text: s.serverOrigin
                color: theme.primary
                placeholderText: S.SERVER_PLACEHOLDER
                placeholderTextColor: theme.secondary
                selectByMouse: true
                font.pixelSize: 15
                Accessible.name: S.SERVER_LABEL
                onAccepted: backend.prepare(text)
                background: Rectangle {
                    color: theme.surface; radius: 8
                    border.color: serverField.activeFocus ? theme.accent : theme.border
                    border.width: serverField.activeFocus ? 2 : 1
                }
            }
        }

        RowLayout {
            spacing: 10
            CosmosButton {
                id: setupButton
                primary: true
                text: root.working ? S.SETUP_WORKING : (s.editingServer ? S.SERVER_USE : S.SETUP_ACTION)
                enabled: s.canPrepare && !root.working
                onClicked: backend.prepare(serverField.visible ? serverField.text : s.serverOrigin)
            }
            CosmosButton {
                text: S.SERVER_KEEP
                visible: s.editingServer
                onClicked: backend.cancelServerChange()
            }
            CosmosWaveform {
                visible: root.working
                Layout.preferredWidth: 36; Layout.preferredHeight: 26
                phase: "thinking"; motionEnabled: window.motionEnabled
            }
        }

        Label {
            Layout.fillWidth: true
            Layout.maximumWidth: theme.maxLineWidth
            Layout.minimumHeight: 22
            wrapMode: Text.Wrap
            color: s.phase === "blocked" ? theme.error : theme.response
            font.pixelSize: 14
            text: s.message
            Accessible.name: "Notice"
            Accessible.role: Accessible.StaticText
        }

        Disclosure {
            Layout.fillWidth: true
            Layout.maximumWidth: theme.maxLineWidth
            RowLayout {
                spacing: 10
                CosmosButton {
                    text: S.SERVER_CHANGE
                    visible: !s.editingServer
                    enabled: s.canPrepare
                    implicitHeight: 30
                    onClicked: { backend.beginServerChange(); serverField.forceActiveFocus() }
                }
            }
            Label {
                Layout.fillWidth: true
                wrapMode: Text.Wrap
                color: theme.secondary
                font.pixelSize: 13
                text: s.keyNotice
            }
        }
    }

    Component.onCompleted: focusPrimary()
}
