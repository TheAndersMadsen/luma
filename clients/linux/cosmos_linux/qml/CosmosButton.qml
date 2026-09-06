import QtQuick
import QtQuick.Controls

Button {
    id: control
    implicitHeight: 40
    implicitWidth: Math.max(84, contentItem.implicitWidth + 28)
    focusPolicy: Qt.StrongFocus
    Accessible.name: text
    contentItem: Text {
        text: control.text
        font: control.font
        color: control.enabled ? "#F2F7F8" : "#A4B7BE"
        horizontalAlignment: Text.AlignHCenter
        verticalAlignment: Text.AlignVCenter
    }
    background: Rectangle {
        radius: 6
        color: control.down ? "#20464B" : (control.hovered ? "#1C2D33" : "#111B20")
        border.width: control.activeFocus ? 2 : 1
        border.color: control.activeFocus ? "#27E6DF" : "#33464D"
    }
}
