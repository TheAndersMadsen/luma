import QtQuick
import QtQuick.Controls

// A small pill control: destination, attached context, example prompts.
// Optional trailing close action. Same focus ring as every other control.
AbstractButton {
    id: chip
    property bool active: false
    property bool closable: false
    property string closeName: ""
    signal closed()
    implicitHeight: 30
    leftPadding: 12
    rightPadding: closable ? 8 : 12
    topPadding: 0
    bottomPadding: 0
    focusPolicy: Qt.StrongFocus
    hoverEnabled: true
    Accessible.role: Accessible.Button
    Accessible.name: text
    background: Rectangle {
        radius: height / 2
        color: chip.down ? theme.border : (chip.hovered || chip.active ? theme.surface : "transparent")
        border.width: chip.activeFocus ? 2 : 1
        border.color: chip.activeFocus ? theme.accent : (chip.active ? theme.accent : theme.border)
        Behavior on color { ColorAnimation { duration: window.motionMs } }
    }
    contentItem: Row {
        spacing: 6
        Text {
            text: chip.text
            color: chip.enabled ? (chip.active ? theme.response : theme.primary) : theme.secondary
            font.pixelSize: 13
            height: chip.availableHeight
            verticalAlignment: Text.AlignVCenter
            elide: Text.ElideRight
            width: Math.min(implicitWidth, 320)
        }
        AbstractButton {
            id: closeButton
            visible: chip.closable
            width: 18; height: 18
            y: (chip.availableHeight - height) / 2
            focusPolicy: Qt.StrongFocus
            Accessible.role: Accessible.Button
            Accessible.name: chip.closeName
            onClicked: chip.closed()
            background: Rectangle {
                radius: 9
                color: closeButton.hovered ? theme.border : "transparent"
                border.width: closeButton.activeFocus ? 2 : 0
                border.color: theme.accent
            }
            contentItem: Text {
                text: "×"
                color: theme.secondary
                font.pixelSize: 15
                horizontalAlignment: Text.AlignHCenter
                verticalAlignment: Text.AlignVCenter
            }
        }
    }
}
