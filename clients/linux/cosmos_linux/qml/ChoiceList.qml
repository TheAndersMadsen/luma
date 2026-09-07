import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// A numbered list of 2 to 8 options. Digits, arrow keys and Enter, or a click,
// pick one; the item's title is sent as the next request.
FocusScope {
    id: root
    property var items: []
    property string title: ""
    property int currentIndex: 0
    signal picked(int index)
    implicitHeight: column.implicitHeight
    Accessible.role: Accessible.List
    Accessible.name: title

    function pick(index) {
        if (!enabled || index < 0 || index >= items.length) return
        currentIndex = index
        picked(index)
    }
    function focusList() {
        if (items.length > 0) root.forceActiveFocus()
    }

    Keys.onPressed: function(event) {
        if (event.key >= Qt.Key_1 && event.key <= Qt.Key_8) {
            const index = event.key - Qt.Key_1
            if (index < items.length) { pick(index); event.accepted = true }
        } else if (event.key === Qt.Key_Down) {
            currentIndex = Math.min(items.length - 1, currentIndex + 1); event.accepted = true
        } else if (event.key === Qt.Key_Up) {
            currentIndex = Math.max(0, currentIndex - 1); event.accepted = true
        } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter || event.key === Qt.Key_Space) {
            pick(currentIndex); event.accepted = true
        }
    }

    ColumnLayout {
        id: column
        width: parent.width
        spacing: 6

        Label {
            Layout.fillWidth: true
            text: root.title
            color: theme.primary
            font.pixelSize: theme.body
            font.weight: Font.DemiBold
            wrapMode: Text.Wrap
        }

        Repeater {
            model: root.items
            delegate: Rectangle {
                id: row
                required property var modelData
                required property int index
                Layout.fillWidth: true
                implicitHeight: Math.max(44, rowLayout.implicitHeight + 16)
                radius: 8
                color: index === root.currentIndex && root.activeFocus ? theme.surface : (mouse.containsMouse ? theme.surface : "transparent")
                border.width: index === root.currentIndex && root.activeFocus ? 2 : 1
                border.color: index === root.currentIndex && root.activeFocus ? theme.accent : theme.border
                Behavior on color { ColorAnimation { duration: window.motionMs } }
                Accessible.role: Accessible.ListItem
                Accessible.name: (index + 1) + ". " + modelData.title + (modelData.detail.length > 0 ? ". " + modelData.detail : "")
                Accessible.focusable: true

                MouseArea {
                    id: mouse
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: root.pick(index)
                }

                RowLayout {
                    id: rowLayout
                    anchors.fill: parent
                    anchors.margins: 8
                    spacing: 12
                    Rectangle {
                        Layout.preferredWidth: 26; Layout.preferredHeight: 26
                        Layout.alignment: Qt.AlignTop
                        radius: 13
                        color: theme.accent
                        Label {
                            anchors.centerIn: parent
                            text: index + 1
                            color: theme.panel
                            font.pixelSize: 13
                            font.weight: Font.Bold
                        }
                    }
                    ColumnLayout {
                        Layout.fillWidth: true
                        spacing: 2
                        Label {
                            Layout.fillWidth: true
                            text: modelData.title
                            color: theme.primary
                            font.pixelSize: theme.body - 1
                            wrapMode: Text.Wrap
                        }
                        Label {
                            Layout.fillWidth: true
                            visible: modelData.detail.length > 0
                            text: modelData.detail
                            color: theme.secondary
                            font.pixelSize: 13
                            wrapMode: Text.Wrap
                        }
                    }
                }
            }
        }
    }
}
