import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Item {
    id: root
    property var s: backend.state

    function focusPrimary() {
        if (serverField.visible) serverField.forceActiveFocus()
        else setupButton.forceActiveFocus()
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 6
        spacing: 14

        Label { text: "Set up this computer"; color: "#F2F7F8"; font.pixelSize: 26; font.bold: true }
        Label {
            Layout.fillWidth: true
            wrapMode: Text.Wrap
            color: "#A4B7BE"
            font.pixelSize: 15
            text: "This computer joins your Cosmos room as one approved installation. It sends the public text you type, shows one shared card and plays spoken replies while this window is visible. No microphone, no screen capture, no private retrieval."
        }

        RowLayout {
            spacing: 10
            Label { text: "Server"; color: "#A4B7BE" }
            Label {
                text: s.serverHost
                color: "#F2F7F8"
                font.pixelSize: 15
                visible: !s.editingServer
            }
            Label { text: "·"; color: "#A4B7BE"; visible: !s.editingServer }
            CosmosButton {
                text: "Change"
                visible: !s.editingServer
                enabled: s.canPrepare
                implicitHeight: 30
                onClicked: { backend.beginServerChange(); serverField.forceActiveFocus() }
            }
        }

        TextField {
            id: serverField
            visible: s.editingServer
            Layout.fillWidth: true
            Layout.preferredHeight: 42
            text: s.serverOrigin
            color: "#F2F7F8"
            placeholderText: "https://center.example"
            placeholderTextColor: "#A4B7BE"
            selectByMouse: true
            Accessible.name: "HTTPS server address"
            onAccepted: backend.prepare(text)
            background: Rectangle {
                color: "#111B20"; radius: 6
                border.color: serverField.activeFocus ? "#27E6DF" : "#33464D"
                border.width: serverField.activeFocus ? 2 : 1
            }
        }

        Label {
            Layout.fillWidth: true
            wrapMode: Text.Wrap
            color: "#A4B7BE"
            font.pixelSize: 13
            text: s.keyNotice
        }

        RowLayout {
            spacing: 10
            CosmosButton {
                id: setupButton
                text: s.editingServer ? "Use this server" : "Set up this computer"
                enabled: s.canPrepare
                onClicked: backend.prepare(serverField.visible ? serverField.text : s.serverOrigin)
            }
            CosmosButton {
                text: "Keep current"
                visible: s.editingServer
                onClicked: backend.cancelServerChange()
            }
        }

        Label {
            Layout.fillWidth: true
            wrapMode: Text.Wrap
            color: "#58F4F1"
            font.pixelSize: 14
            text: s.message
            Accessible.name: "Operation status"
        }

        Item { Layout.fillHeight: true }
    }

    Component.onCompleted: focusPrimary()
}
