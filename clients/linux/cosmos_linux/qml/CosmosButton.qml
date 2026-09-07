import QtQuick
import QtQuick.Controls

// A keyboard-first button from the Omarchy kit: graphite by default, cyan when
// it is the one primary action, a visible focus ring, never a dead click.
Button {
    id: control
    property bool primary: false
    implicitHeight: theme.controlHeight
    implicitWidth: Math.max(88, contentItem.implicitWidth + 32)
    focusPolicy: Qt.StrongFocus
    Accessible.name: text
    Accessible.role: Accessible.Button
    contentItem: Text {
        text: control.text
        font: control.font
        color: control.primary ? (control.enabled ? theme.panel : theme.secondary)
                               : (control.enabled ? theme.primary : theme.secondary)
        horizontalAlignment: Text.AlignHCenter
        verticalAlignment: Text.AlignVCenter
        elide: Text.ElideRight
    }
    background: Rectangle {
        radius: 8
        color: control.primary
            ? (control.enabled ? (control.down ? theme.response : theme.accent) : theme.surface)
            : (control.down ? theme.border : (control.hovered ? theme.surface : "transparent"))
        border.width: control.activeFocus ? 2 : 1
        border.color: control.activeFocus ? theme.accent : (control.primary && control.enabled ? theme.accent : theme.border)
        Behavior on color { ColorAnimation { duration: window.motionMs; easing.type: Easing.OutCubic } }
    }
}
