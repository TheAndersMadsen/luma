import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Item {
    id: root
    property var s: backend.state
    property bool advanced: false

    function focusPrimary() { openButton.forceActiveFocus() }

    RowLayout {
        anchors.fill: parent
        anchors.margins: 6
        spacing: 24

        ColumnLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            spacing: 12

            Label { text: "Approve in Center"; color: "#F2F7F8"; font.pixelSize: 26; font.bold: true }
            Label {
                Layout.fillWidth: true
                wrapMode: Text.Wrap
                color: "#A4B7BE"
                font.pixelSize: 15
                text: "Scan the code with your phone or open the link here. Center fills in this computer's public descriptor and shows the same fingerprint; approve only if they match. This window connects by itself once approved."
            }

            Label { text: "Public-key fingerprint"; color: "#A4B7BE"; font.pixelSize: 12 }
            TextEdit {
                Layout.fillWidth: true
                text: s.fingerprint
                readOnly: true
                selectByMouse: true
                wrapMode: TextEdit.Wrap
                color: "#58F4F1"
                font.family: "monospace"
                font.pixelSize: 15
                Accessible.name: "Installation fingerprint"
            }

            RowLayout {
                spacing: 10
                CosmosButton {
                    id: openButton
                    text: "Open in browser"
                    enabled: s.approvalUrl.length > 0
                    onClicked: backend.openApproval()
                }
                CosmosButton {
                    text: "Connect now"
                    enabled: s.canConnect
                    onClicked: backend.connect()
                }
                CosmosButton {
                    text: advanced ? "Hide advanced" : "Advanced"
                    onClicked: advanced = !advanced
                }
            }

            ColumnLayout {
                visible: advanced
                spacing: 8
                RowLayout {
                    spacing: 10
                    CosmosButton { text: "Copy descriptor"; onClicked: backend.copyDescriptor() }
                    CosmosButton { text: "Copy link"; onClicked: backend.copyApprovalLink() }
                    CosmosButton { text: "Change server"; enabled: s.canPrepare; onClicked: backend.beginServerChange() }
                }
                Label {
                    Layout.fillWidth: true
                    wrapMode: Text.WrapAnywhere
                    color: "#A4B7BE"
                    font.family: "monospace"
                    font.pixelSize: 11
                    text: s.descriptorJson
                }
                Label {
                    Layout.fillWidth: true
                    wrapMode: Text.Wrap
                    color: "#A4B7BE"
                    font.pixelSize: 12
                    text: s.keyNotice
                }
            }

            Label {
                Layout.fillWidth: true
                wrapMode: Text.Wrap
                color: "#58F4F1"
                font.pixelSize: 14
                text: s.message
                Accessible.name: "Operation status"
            }

            Item { Layout.fillHeight: true }
        }

        Rectangle {
            Layout.alignment: Qt.AlignTop
            Layout.preferredWidth: 236
            Layout.preferredHeight: 236
            radius: 10
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
