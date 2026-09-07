import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// One command this computer was asked to carry out: the state word, one plain
// sentence, how long it has been going, and "Cancel task" — which is not the
// same thing as closing the window. A refusal reads "Not done" with one
// sentence on what happened and one on what to do.
Rectangle {
    id: root
    property var task: null
    property bool cancellable: task != null && task.cancellable === true
    visible: task != null
    Layout.fillWidth: true
    implicitHeight: visible ? layout.implicitHeight + 24 : 0
    radius: 10
    color: theme.panel
    border.width: 1
    border.color: task != null && task.tone === "error" ? theme.error : theme.border
    Accessible.role: Accessible.Grouping
    Accessible.name: task != null ? (task.title + ". " + task.detail + " " + task.remedy).trim() : ""
    Behavior on implicitHeight { NumberAnimation { duration: window.motionMs; easing.type: Easing.OutCubic } }

    ColumnLayout {
        id: layout
        anchors.fill: parent
        anchors.margins: 12
        spacing: 4

        RowLayout {
            Layout.fillWidth: true
            spacing: 8
            Label {
                text: root.task ? root.task.title : ""
                color: root.task && root.task.tone === "error" ? theme.error : theme.primary
                font.pixelSize: 15
                font.weight: Font.DemiBold
            }
            Item { Layout.fillWidth: true }
            // The clock is the client's own, from one monotonic source.
            Label {
                text: root.task ? root.task.elapsed : ""
                visible: text.length > 0
                color: theme.secondary
                font.pixelSize: 13
                font.family: "monospace"
                Accessible.name: text
            }
        }
        Label {
            Layout.fillWidth: true
            Layout.maximumWidth: theme.maxLineWidth
            text: root.task ? root.task.detail : ""
            color: theme.primary
            font.pixelSize: 14
            wrapMode: Text.Wrap
        }
        Label {
            Layout.fillWidth: true
            Layout.maximumWidth: theme.maxLineWidth
            visible: root.task != null && root.task.remedy.length > 0
            text: root.task ? root.task.remedy : ""
            color: theme.secondary
            font.pixelSize: 13
            wrapMode: Text.Wrap
        }
        RowLayout {
            Layout.fillWidth: true
            Layout.topMargin: 4
            spacing: 8
            visible: root.cancellable
            Label {
                text: S.TASK_CLOSE_NOTE
                color: theme.secondary
                font.pixelSize: 12
                Layout.fillWidth: true
                elide: Text.ElideRight
            }
            CosmosButton {
                text: S.CANCEL_TASK + "  " + S.CANCEL_TASK_HINT
                implicitHeight: 30
                Accessible.name: S.CANCEL_TASK
                onClicked: backend.cancelTask()
            }
        }
    }
}
