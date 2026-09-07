import QtQuick
import QtQuick.Controls

// No destination by default: Cosmos chooses the screen from what the answer is,
// and the chip is an offer rather than a step. Opening it lists the other
// devices by friendly name; a named one shows as "→ Shield TV" and clears from
// the chip itself. The choice holds for this session only.
Chip {
    id: chip
    property var s: backend.state
    property bool named: s.target.length > 0
    text: named ? s.destinationChip : S.DESTINATION_TITLE
    active: named
    closable: named
    closeName: S.DESTINATION_CLEAR
    Accessible.name: S.DESTINATION_TITLE + ": " + (named ? s.destinationChip : S.ANY_DEVICE)
    onClicked: menu.open()
    onClosed: backend.setTarget("")

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
