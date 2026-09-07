import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// The state vocabulary in the window header: a headline ("Working", "Waiting
// for you", "Completed", ...) and one plain sentence under it. Space is
// reserved so the layout never jumps; "Connected" fades out on its own.
Item {
    id: root
    property string title: ""
    property string detail: ""
    property string tone: "idle"
    property bool detailShown: true
    implicitHeight: 44
    implicitWidth: Math.max(titleLabel.implicitWidth, detailLabel.implicitWidth)
    Accessible.role: Accessible.StatusBar
    Accessible.name: (title + " " + detail).trim()

    function announce() {
        detailShown = true
        if (title === "" && detail === S.CONNECTED) fade.restart()
        else fade.stop()
        const spoken = (title + ". " + detail).trim()
        if (spoken.length > 1 && typeof Accessible.announce === "function") Accessible.announce(spoken)
    }
    onTitleChanged: announce()
    onDetailChanged: announce()
    Component.onCompleted: announce()

    Timer { id: fade; interval: 2500; onTriggered: root.detailShown = false }

    Column {
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        spacing: 2
        Label {
            id: titleLabel
            anchors.right: parent.right
            text: root.title
            color: root.tone === "error" ? theme.error : theme.primary
            font.pixelSize: 15
            font.weight: Font.DemiBold
            opacity: root.title.length > 0 ? 1 : 0
            Behavior on opacity { NumberAnimation { duration: window.motionMs } }
        }
        Label {
            id: detailLabel
            anchors.right: parent.right
            text: root.detail
            color: theme.secondary
            font.pixelSize: 13
            opacity: root.detail.length > 0 && root.detailShown ? 1 : 0
            Behavior on opacity { NumberAnimation { duration: root.detailShown ? window.motionMs : 600 } }
        }
    }
}
