import QtQuick
import QtQuick.Controls

// "→ This screen" by default. Opening it lists the devices by friendly name;
// the choice holds for this session only and is sent with the next request.
Chip {
    id: chip
    property var s: backend.state
    text: s.destinationChip
    active: s.target.length > 0
    Accessible.name: S.DESTINATION_TITLE + ": " + s.destinationChip
    onClicked: menu.open()

    Menu {
        id: menu
        y: chip.height + 4
        title: S.DESTINATION_TITLE
        onOpened: window.popupOpen = true
        onClosed: { window.popupOpen = false; chip.forceActiveFocus() }
        background: Rectangle {
            implicitWidth: 220
            color: theme.surface
            radius: 8
            border.color: theme.border
            border.width: 1
        }
        Repeater {
            model: s.destinations
            delegate: MenuItem {
                id: entry
                required property var modelData
                text: modelData.name + (modelData.online ? "" : " · " + S.OFFLINE)
                enabled: modelData.online
                checkable: true
                checked: modelData.current
                Accessible.name: text
                onTriggered: backend.setTarget(modelData.target)
                contentItem: Text {
                    text: entry.text
                    color: entry.enabled ? (entry.checked ? theme.response : theme.primary) : theme.secondary
                    font.pixelSize: 14
                    verticalAlignment: Text.AlignVCenter
                    leftPadding: 8
                }
                background: Rectangle {
                    implicitHeight: 36
                    color: entry.highlighted ? theme.border : "transparent"
                    radius: 6
                }
                indicator: Item { width: 0; height: 0 }
            }
        }
    }
}
