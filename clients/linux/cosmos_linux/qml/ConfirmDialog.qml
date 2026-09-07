import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// The ceremony. The words are the runtime's own, composed from the owner's
// label; this file only frames them. Two choices of equal weight, a visible
// countdown, Enter confirms and Escape dismisses the panel WITHOUT answering —
// the request then runs out, which denies by default. Every other key is
// swallowed here, so no stray keypress can ever resolve it.
Popup {
    id: root
    property var ceremony: null
    modal: true
    focus: true
    closePolicy: Popup.NoAutoClose
    anchors.centerIn: Overlay.overlay
    width: Math.min(parent ? parent.width - 48 : 520, 520)
    padding: 20

    background: Rectangle {
        color: theme.panel
        radius: theme.panelRadius
        border.width: 2
        border.color: theme.accent
    }
    Overlay.modal: Rectangle { color: Qt.rgba(0, 0, 0, 0.55) }

    // Nothing here takes focus on its own, so no keypress lands on a button by
    // accident. Enter and Escape are bound once, in Main.qml, and they are the
    // only two keys that do anything while this is on screen; the buttons are
    // reached by Tab or by pointer, deliberately.
    // The popup takes the keyboard while it is on screen: its content item holds
    // focus and answers exactly two keys.
    onOpened: Qt.callLater(function() { keys.forceActiveFocus() })

    contentItem: FocusScope {
        id: keys
        objectName: "ceremonyKeys"
        focus: true
        implicitHeight: column.implicitHeight
        Keys.onPressed: function(event) {
            if (event.key === Qt.Key_Tab || event.key === Qt.Key_Backtab) return
            const named = (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) ? "return"
                        : (event.key === Qt.Key_Escape || event.key === Qt.Key_Back) ? "escape" : "other"
            backend.ceremonyKey(named)
            event.accepted = true
        }
        Accessible.role: Accessible.Dialog
        Accessible.name: root.ceremony ? (root.ceremony.question + " " + root.ceremony.effect) : ""

        ColumnLayout {
            id: column
            width: parent.width
            spacing: 10

            RowLayout {
                Layout.fillWidth: true
                Label {
                    text: S.CONFIRM_TITLE
                    color: theme.secondary
                    font.pixelSize: 12
                    Layout.fillWidth: true
                }
                // The clock is visible for the whole ceremony.
                Label {
                    text: root.ceremony ? root.ceremony.countdown : ""
                    color: root.ceremony && root.ceremony.seconds <= 5 ? theme.error : theme.secondary
                    font.pixelSize: 12
                    font.family: "monospace"
                    Accessible.name: text
                }
            }
            Label {
                Layout.fillWidth: true
                Layout.maximumWidth: theme.maxLineWidth
                text: root.ceremony ? root.ceremony.question : ""
                color: theme.primary
                font.pixelSize: 18
                font.weight: Font.DemiBold
                wrapMode: Text.Wrap
            }
            Label {
                Layout.fillWidth: true
                Layout.maximumWidth: theme.maxLineWidth
                text: root.ceremony ? root.ceremony.effect : ""
                color: theme.primary
                font.pixelSize: 14
                wrapMode: Text.Wrap
            }
            Label {
                Layout.fillWidth: true
                visible: root.ceremony != null && root.ceremony.note.length > 0
                text: root.ceremony ? root.ceremony.note : ""
                color: theme.secondary
                font.pixelSize: 13
                wrapMode: Text.Wrap
            }
            Label {
                Layout.fillWidth: true
                Layout.maximumWidth: theme.maxLineWidth
                visible: root.ceremony != null && root.ceremony.cannotReason.length > 0
                text: root.ceremony ? root.ceremony.cannotReason : ""
                color: theme.error
                font.pixelSize: 13
                wrapMode: Text.Wrap
            }
            // Two buttons of the same size and the same weight. Neither is the
            // primary accent: declining is not the lesser answer.
            RowLayout {
                Layout.fillWidth: true
                Layout.topMargin: 4
                spacing: 10
                CosmosButton {
                    Layout.fillWidth: true
                    text: S.CONFIRM_DECLINE
                    onClicked: backend.declineTask()
                }
                CosmosButton {
                    Layout.fillWidth: true
                    text: S.CONFIRM_ALLOW
                    enabled: root.ceremony != null && root.ceremony.canConfirm
                    onClicked: backend.confirmTask()
                }
            }
            Label {
                Layout.fillWidth: true
                text: root.ceremony && !root.ceremony.canConfirm ? S.CONFIRM_HINT_DECLINE_ONLY
                                                                 : S.CONFIRM_HINT
                color: theme.secondary
                font.pixelSize: 12
                elide: Text.ElideRight
            }
        }
    }
}
