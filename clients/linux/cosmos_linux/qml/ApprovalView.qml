import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// First run, step two: the QR code and one button. The fingerprint, the
// copy actions and the raw descriptor stay behind Details. The window
// connects by itself once Center approves.
Item {
    id: root
    property var s: backend.state
    property bool copied: false

    function focusPrimary() { openButton.forceActiveFocus() }
    function sendFromAnywhere() { if (openButton.enabled) openButton.clicked() }
    function flashCopied() { copied = true; copiedTimer.restart() }

    Timer { id: copiedTimer; interval: 1500; onTriggered: root.copied = false }

    RowLayout {
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.margins: 6
        spacing: 28

        ColumnLayout {
            Layout.fillWidth: true
            Layout.alignment: Qt.AlignTop
            spacing: 14

            Label {
                text: S.APPROVAL_TITLE
                color: theme.primary
                font.pixelSize: 26
                font.weight: Font.DemiBold
                Accessible.role: Accessible.Heading
            }
            Label {
                Layout.fillWidth: true
                Layout.maximumWidth: theme.maxLineWidth
                wrapMode: Text.Wrap
                color: theme.secondary
                font.pixelSize: theme.body - 2
                lineHeight: 1.25
                text: S.APPROVAL_BODY
            }

            RowLayout {
                spacing: 10
                CosmosButton {
                    id: openButton
                    primary: true
                    text: S.APPROVAL_OPEN
                    enabled: s.approvalUrl.length > 0
                    onClicked: backend.openApproval()
                }
                CosmosButton {
                    text: S.APPROVAL_CONNECT
                    visible: s.canConnect && !s.reconnectArmed
                    onClicked: backend.connect()
                }
            }

            RowLayout {
                spacing: 10
                Layout.minimumHeight: 26
                CosmosWaveform {
                    Layout.preferredWidth: 36; Layout.preferredHeight: 26
                    phase: s.phase === "blocked" ? "error" : "thinking"
                    motionEnabled: window.motionEnabled
                }
                Label {
                    Layout.fillWidth: true
                    wrapMode: Text.Wrap
                    color: s.phase === "blocked" ? theme.error : theme.response
                    font.pixelSize: 14
                    text: s.phase === "blocked" ? s.message : S.APPROVAL_WAITING
                    Accessible.name: "Notice"
                }
            }

            Disclosure {
                Layout.fillWidth: true
                Layout.maximumWidth: theme.maxLineWidth
                Label { text: S.FINGERPRINT_LABEL; color: theme.secondary; font.pixelSize: 12 }
                TextEdit {
                    Layout.fillWidth: true
                    text: s.fingerprint
                    readOnly: true
                    selectByMouse: true
                    wrapMode: TextEdit.Wrap
                    color: theme.response
                    font.family: "monospace"
                    font.pixelSize: 14
                    Accessible.name: S.FINGERPRINT_LABEL
                }
                RowLayout {
                    spacing: 10
                    CosmosButton { text: S.COPY_LINK; implicitHeight: 30; onClicked: { if (backend.copyApprovalLink()) root.flashCopied() } }
                    CosmosButton { text: S.COPY_DESCRIPTOR; implicitHeight: 30; onClicked: { if (backend.copyDescriptor()) root.flashCopied() } }
                    CosmosButton { text: S.CHANGE_SERVER; implicitHeight: 30; enabled: s.canPrepare; onClicked: backend.beginServerChange() }
                    Label {
                        text: S.COPIED
                        color: theme.success
                        font.pixelSize: 13
                        opacity: root.copied ? 1 : 0
                        Behavior on opacity { NumberAnimation { duration: window.motionMs } }
                    }
                }
                Label {
                    Layout.fillWidth: true
                    wrapMode: Text.Wrap
                    color: theme.secondary
                    font.pixelSize: 13
                    text: s.keyNotice
                }
                TextEdit {
                    Layout.fillWidth: true
                    text: s.descriptorJson
                    readOnly: true
                    selectByMouse: true
                    wrapMode: TextEdit.WrapAnywhere
                    color: theme.secondary
                    font.family: "monospace"
                    font.pixelSize: 11
                    Accessible.name: "Descriptor"
                }
            }
        }

        Rectangle {
            Layout.alignment: Qt.AlignTop
            Layout.preferredWidth: 236
            Layout.preferredHeight: 236
            radius: 12
            color: "#FFFFFF"
            visible: s.approvalQr.length > 0
            Image {
                anchors.fill: parent
                anchors.margins: 8
                source: s.approvalQr
                fillMode: Image.PreserveAspectFit
                smooth: false
                Accessible.name: "Approval QR code for Center"
            }
        }
    }

    Component.onCompleted: focusPrimary()
}
