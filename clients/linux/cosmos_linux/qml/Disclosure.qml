import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// The single "Details" disclosure: technical detail lives behind it, never in
// the main flow. The height animates so nothing below it jumps.
ColumnLayout {
    id: root
    property bool open: false
    property string label: S.DETAILS
    property string openLabel: S.HIDE_DETAILS
    default property alias content: body.data
    spacing: 8

    CosmosButton {
        id: toggle
        text: root.open ? root.openLabel : root.label
        implicitHeight: 30
        implicitWidth: contentItem.implicitWidth + 28
        onClicked: root.open = !root.open
        Accessible.name: text
    }

    Item {
        Layout.fillWidth: true
        implicitHeight: root.open ? body.implicitHeight : 0
        clip: true
        Behavior on implicitHeight { NumberAnimation { duration: window.motionMs; easing.type: Easing.OutCubic } }
        ColumnLayout {
            id: body
            width: parent.width
            spacing: 8
            opacity: root.open ? 1 : 0
            visible: opacity > 0
            Behavior on opacity { NumberAnimation { duration: window.motionMs } }
        }
    }
}
