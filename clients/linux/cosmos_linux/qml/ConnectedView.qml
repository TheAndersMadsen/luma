import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import QtQuick.Dialogs

// Quiet presence: the panel, the prompt, the destination and context chips.
// Enter sends, Esc closes the window without touching the task, "Cancel task"
// is its own explicit action, digits pick from a choice list.
Item {
    id: root
    property var s: backend.state
    property string sentText: ""
    property bool choicesShown: s.display != null && s.display.kind === "choices"
    property bool ceremonyShown: s.ceremony != null

    FileDialog {
        id: fileAttachment
        objectName: "fileAttachment"
        title: "Attach a saved text file"
        fileMode: FileDialog.OpenFile
        onAccepted: backend.attachFile(selectedFile.toString())
    }
    Menu {
        id: attachments
        MenuItem {
            text: S.USE_SELECTION
            visible: s.hasScreenContext
            height: visible ? implicitHeight : 0
            onTriggered: backend.useSelection()
        }
        MenuItem {
            objectName: "attachFileChoice"
            text: "Attach text file…"
            visible: s.features.document
            height: visible ? implicitHeight : 0
            onTriggered: fileAttachment.open()
        }
    }

    function focusPrimary() { prompt.forceActiveFocus(); prompt.selectAll() }

    function send() {
        if (!s.canSend || prompt.text.trim().length === 0) return
        if (backend.send(prompt.text)) sentText = prompt.text
    }
    function sendFromAnywhere() { send() }
    function sendExample(text) {
        if (!s.canSend) return
        prompt.text = text
        send()
    }

    Connections {
        target: backend
        function onSent(ok) {
            if (ok && prompt.text === root.sentText) prompt.text = ""
            root.sentText = ""
            if (ok) prompt.forceActiveFocus()
        }
    }
    onChoicesShownChanged: if (choicesShown && prompt.text.length === 0) panel.focusChoices()

    // The ceremony is its own card, above everything, and it is answered only
    // by a deliberate action.
    ConfirmDialog {
        id: ceremony
        ceremony: s.ceremony
        parent: Overlay.overlay
    }
    onCeremonyShownChanged: ceremonyShown ? ceremony.open() : ceremony.close()
    Component.onDestruction: ceremony.close()

    ColumnLayout {
        anchors.fill: parent
        spacing: 10

        // What this computer is doing about a command, or what it did.
        TaskCard { task: s.task }

        DocumentView {
            Layout.fillWidth: true
            Layout.fillHeight: true
            visible: s.document != null
            document: s.document
        }

        CosmosPanel {
            id: panel
            visible: s.document == null
            Layout.fillWidth: true
            Layout.fillHeight: true
            card: s.display
            speech: s.speech
            speaking: s.speaking
            sentText: s.sentText
            motionEnabled: window.motionEnabled
            onChoicePicked: function(index) { backend.selectChoice(index) }
            onExamplePicked: function(text) { root.sendExample(text) }
        }

        // Chips: where the reply should go and what is attached. Reserved height.
        RowLayout {
            Layout.fillWidth: true
            Layout.minimumHeight: 32
            spacing: 8
            DestinationPicker { visible: s.features.targets; enabled: s.canSend }
            Chip {
                objectName: "attachText"
                visible: (s.features.document || s.hasScreenContext) && s.context == null
                text: s.contextBusy ? "Attaching…" : "Attach"
                enabled: s.canSend && !s.contextBusy
                onClicked: attachments.popup()
            }
            Chip {
                visible: s.context != null
                active: true
                closable: true
                closeName: S.DROP_CONTEXT
                text: s.context ? s.context.label : ""
                onClicked: backend.dropContext()
                onClosed: backend.dropContext()
            }
            Item { Layout.fillWidth: true }
            // Close and Cancel task sit side by side so the difference is visible:
            // closing hides the window and the turn keeps running.
            CosmosButton {
                text: S.CLOSE
                implicitHeight: 30
                onClicked: backend.hideWindow()
            }
            CosmosButton {
                text: S.CANCEL_TASK
                implicitHeight: 30
                visible: !s.canCancelTask && s.canCancel && (s.turnOpen || s.sentText.length > 0)
                onClicked: backend.cancel()
            }
            CosmosButton {
                text: S.RETRY
                implicitHeight: 30
                visible: s.canRetry
                onClicked: backend.retryPending()
            }
        }

        RowLayout {
            spacing: 10
            TextField {
                id: prompt
                Layout.fillWidth: true
                Layout.preferredHeight: 44
                color: theme.primary
                font.pixelSize: 15
                placeholderText: s.canSend ? S.PROMPT_PLACEHOLDER : (s.sending ? S.WORKING : S.PROMPT_WAITING)
                placeholderTextColor: theme.secondary
                selectByMouse: true
                enabled: s.canSend
                maximumLength: 4000
                Accessible.name: S.PROMPT_PLACEHOLDER
                onAccepted: root.send()
                Keys.onPressed: function(event) {
                    // A digit with an empty prompt picks from the choice list; otherwise it types.
                    if (root.choicesShown && text.length === 0 && event.key >= Qt.Key_1 && event.key <= Qt.Key_8) {
                        const index = event.key - Qt.Key_1
                        if (index < s.display.items.length) { backend.selectChoice(index); event.accepted = true }
                    } else if (root.choicesShown && text.length === 0 && event.key === Qt.Key_Down) {
                        panel.focusChoices(); event.accepted = true
                    }
                }
                background: Rectangle {
                    color: theme.surface; radius: 8
                    border.color: prompt.activeFocus ? theme.accent : theme.border
                    border.width: prompt.activeFocus ? 2 : 1
                    Behavior on border.color { ColorAnimation { duration: window.motionMs } }
                }
            }
            CosmosButton {
                primary: true
                text: S.SEND
                enabled: s.canSend && prompt.text.trim().length > 0
                onClicked: root.send()
            }
        }

        // Notice: one sentence on what happened, one on what to do. Reserved height.
        RowLayout {
            Layout.fillWidth: true
            Layout.minimumHeight: 22
            spacing: 10
            Label {
                Layout.fillWidth: true
                Layout.maximumWidth: theme.maxLineWidth
                wrapMode: Text.Wrap
                color: s.phase === "blocked" || s.screenContextOff ? theme.error : theme.secondary
                font.pixelSize: 13
                text: s.hasPending ? S.NOTICE_PENDING : (s.unknownOutcome && s.message.length === 0 ? S.NOTICE_UNKNOWN_OUTCOME : s.message)
                Accessible.name: "Notice"
                Accessible.role: Accessible.StaticText
            }
            CosmosButton {
                visible: s.screenContextOff
                text: S.OPEN_CENTER_DEVICES
                implicitHeight: 28
                onClicked: backend.openCenterDevices()
            }
        }

        Disclosure {
            Layout.fillWidth: true
            RowLayout {
                spacing: 10
                Label { text: S.SERVER_LABEL + ": " + s.serverHost; color: theme.secondary; font.pixelSize: 13 }
                Label { text: "·"; color: theme.secondary }
                Label { text: s.statusText; color: theme.secondary; font.pixelSize: 13 }
                Item { Layout.fillWidth: true }
                CosmosButton {
                    text: s.canDisconnect ? S.DISCONNECT : S.CONNECT
                    implicitHeight: 28
                    enabled: s.canDisconnect || s.canConnect
                    onClicked: s.canDisconnect ? backend.disconnect() : backend.connect()
                }
                CosmosButton { text: S.QUIT; implicitHeight: 28; onClicked: backend.quit() }
            }
            Label {
                Layout.fillWidth: true
                text: S.FINGERPRINT_LABEL + ": " + s.fingerprint
                color: theme.secondary
                font.family: "monospace"
                font.pixelSize: 12
                wrapMode: Text.Wrap
            }
            Label {
                Layout.fillWidth: true
                text: s.keyNotice
                color: theme.secondary
                font.pixelSize: 12
                wrapMode: Text.Wrap
            }
            // What this computer is allowed to open, said once and plainly.
            Label {
                Layout.fillWidth: true
                visible: s.policyNotice.length > 0
                text: s.policyNotice
                color: theme.secondary
                font.pixelSize: 12
                wrapMode: Text.Wrap
            }
        }
    }

    Component.onCompleted: focusPrimary()
}
