import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Item {
    id: root
    property var s: backend.state
    property string sentText: ""

    function focusPrimary() { prompt.forceActiveFocus() }

    function send() {
        if (!s.canSend || prompt.text.trim().length === 0) return
        if (backend.send(prompt.text)) sentText = prompt.text
    }

    Connections {
        target: backend
        function onSent(ok) {
            if (ok && prompt.text === root.sentText) prompt.text = ""
            root.sentText = ""
        }
    }

    ColumnLayout {
        anchors.fill: parent
        spacing: 12

        CosmosPanel {
            Layout.fillWidth: true
            Layout.fillHeight: true
            phase: s.waveformPhase
            card: s.display
            speech: s.speech
            speaking: s.speaking
            motionEnabled: window.motionEnabled
            placeholder: s.connected
                ? (s.visible ? "Ask Cosmos. Replies may appear here or on another approved display."
                             : "Ask Cosmos. Replies appear on your approved displays; this window joins them while it is visible and active.")
                : s.statusText
        }

        RowLayout {
            spacing: 10
            TextField {
                id: prompt
                Layout.fillWidth: true
                Layout.preferredHeight: 42
                color: "#F2F7F8"
                placeholderText: s.canSend ? "Ask Cosmos (public text)…" : "Waiting for the connection…"
                placeholderTextColor: "#A4B7BE"
                selectByMouse: true
                enabled: s.canSend
                maximumLength: 4000
                Accessible.name: "Public request"
                onAccepted: root.send()
                background: Rectangle {
                    color: "#111B20"; radius: 6
                    border.color: prompt.activeFocus ? "#27E6DF" : "#33464D"
                    border.width: prompt.activeFocus ? 2 : 1
                }
            }
            CosmosButton {
                text: "Send"
                enabled: s.canSend && prompt.text.trim().length > 0
                onClicked: root.send()
            }
        }

        Label {
            visible: s.invitation === true
            Layout.fillWidth: true
            wrapMode: Text.Wrap
            color: "#F2F7F8"; font.pixelSize: 13
            text: "A private reply is waiting for this computer. Keep this window in front to receive it."
        }

        RowLayout {
            spacing: 10
            CosmosButton { text: "Cancel request"; visible: s.canCancel; onClicked: backend.cancel() }
            CosmosButton { text: "Retry pending"; visible: s.canRetry; onClicked: backend.retryPending() }
            Label {
                visible: s.hasPending || s.unknownOutcome
                Layout.fillWidth: true
                wrapMode: Text.Wrap
                color: "#A4B7BE"; font.pixelSize: 12
                text: s.hasPending
                    ? "An outcome is uncertain. New requests are paused until the exact pending operation is resolved."
                    : "A previous request has an unknown outcome. It will not be replayed automatically."
            }
            Item { Layout.fillWidth: true; visible: !(s.hasPending || s.unknownOutcome) }
            CosmosButton {
                text: s.canDisconnect ? "Disconnect" : "Connect"
                enabled: s.canDisconnect || s.canConnect
                onClicked: s.canDisconnect ? backend.disconnect() : backend.connect()
            }
        }

        Label {
            Layout.fillWidth: true
            wrapMode: Text.Wrap
            color: "#58F4F1"
            font.pixelSize: 13
            text: s.message
            Accessible.name: "Operation status"
        }
    }

    Component.onCompleted: focusPrimary()
}
