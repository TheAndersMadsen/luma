import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// The response surface from the Omarchy kit, rendering the delivered card
// verbatim (text, or places with inert credit tokens) and the spoken reply.
Item {
    id: root
    property string phase: "idle"
    property bool motionEnabled: true
    property real audioLevel: -1
    property var card: null
    property var speech: null
    property bool speaking: false
    property string placeholder: ""
    implicitWidth: 640
    implicitHeight: 330

    BorderImage {
        anchors.fill: parent
        source: "../assets/panel-frame.png"
        border.left: 34; border.right: 34
        border.top: 34; border.bottom: 34
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 42
        spacing: 14

        RowLayout {
            spacing: 14
            CosmosWaveform {
                Layout.preferredWidth: 48; Layout.preferredHeight: 34
                phase: root.phase; audioLevel: root.audioLevel; motionEnabled: root.motionEnabled
            }
            Label {
                text: root.phase === "idle" ? "Ready" : (root.phase.charAt(0).toUpperCase() + root.phase.slice(1))
                color: "#A4B7BE"
                font.pixelSize: 14
            }
            Item { Layout.fillWidth: true }
            Rectangle {
                visible: root.card != null && root.card.private === true
                radius: height / 2
                color: "#111B20"
                border.color: "#27E6DF"
                border.width: 1
                implicitHeight: 22
                implicitWidth: privateLabel.implicitWidth + 16
                Label {
                    id: privateLabel
                    anchors.centerIn: parent
                    text: "Private · this window only"
                    color: "#58F4F1"; font.pixelSize: 11
                }
            }
            Label { text: "Cosmos"; color: "#A4B7BE"; font.pixelSize: 13 }
        }

        ScrollView {
            id: scroller
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true
            contentWidth: availableWidth

            ColumnLayout {
                width: scroller.availableWidth
                spacing: 12

                // Rendered once per delivered card; the backend acknowledges it after the next painted frame.
                Item {
                    id: cardItem
                    Layout.fillWidth: true
                    visible: root.card != null
                    implicitHeight: cardColumn.implicitHeight
                    property string actionId: root.card ? root.card.actionId : ""
                    onActionIdChanged: if (actionId.length > 0) backend.cardRendered(actionId)
                    Component.onCompleted: if (actionId.length > 0) backend.cardRendered(actionId)
                    Accessible.role: Accessible.Pane
                    Accessible.name: "Cosmos display"

                    ColumnLayout {
                        id: cardColumn
                        width: parent.width
                        spacing: 8

                        TextEdit {
                            Layout.fillWidth: true
                            visible: root.card != null && root.card.kind === "text"
                            text: root.card && root.card.kind === "text" ? root.card.text : ""
                            color: "#58F4F1"
                            textFormat: TextEdit.PlainText
                            wrapMode: TextEdit.Wrap
                            readOnly: true
                            selectByMouse: true
                            font.pixelSize: 17
                            Accessible.name: "Cosmos display text"
                        }

                        Label {
                            Layout.fillWidth: true
                            visible: root.card != null && root.card.kind === "places"
                            text: root.card && root.card.kind === "places" ? root.card.query : ""
                            color: "#F2F7F8"; font.pixelSize: 17; font.bold: true
                            wrapMode: Text.Wrap
                        }
                        Label {
                            visible: root.card != null && root.card.kind === "places" && root.card.items.length === 0
                            text: "No matching places found."
                            color: "#58F4F1"; font.pixelSize: 16
                        }
                        Repeater {
                            model: root.card && root.card.kind === "places" ? root.card.items : []
                            delegate: ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 2
                                Label { text: modelData.name; color: "#F2F7F8"; font.pixelSize: 16; font.bold: true; wrapMode: Text.Wrap; Layout.fillWidth: true }
                                Label { text: modelData.address; color: "#58F4F1"; font.pixelSize: 15; wrapMode: Text.Wrap; Layout.fillWidth: true }
                                Label {
                                    visible: modelData.sourceUrl.length > 0
                                    text: "<a href=\"" + modelData.sourceUrl + "\">View on Google Maps</a>"
                                    textFormat: Text.StyledText
                                    linkColor: "#27E6DF"
                                    font.pixelSize: 14
                                    onLinkActivated: function(link) { backend.openLink(link) }
                                }
                            }
                        }
                        Label {
                            visible: root.card != null && root.card.kind === "places"
                            text: "Google Maps"
                            color: "#A4B7BE"; font.pixelSize: 12; font.bold: true
                        }
                        Repeater {
                            model: root.card && root.card.kind === "places" ? root.card.creditLines : []
                            delegate: Label {
                                Layout.fillWidth: true
                                text: modelData
                                textFormat: Text.StyledText
                                linkColor: "#27E6DF"
                                color: "#A4B7BE"; font.pixelSize: 12
                                wrapMode: Text.Wrap
                                onLinkActivated: function(link) { backend.openLink(link) }
                            }
                        }
                    }
                }

                ColumnLayout {
                    Layout.fillWidth: true
                    visible: root.speech != null
                    spacing: 4
                    Label {
                        text: root.speaking ? "Speaking" : "Spoken reply"
                        color: "#A4B7BE"; font.pixelSize: 12; font.bold: true
                    }
                    TextEdit {
                        Layout.fillWidth: true
                        text: root.speech ? root.speech.text : ""
                        color: "#F2F7F8"
                        textFormat: TextEdit.PlainText
                        wrapMode: TextEdit.Wrap
                        readOnly: true
                        selectByMouse: true
                        font.pixelSize: 16
                        Accessible.name: "Spoken reply"
                    }
                }

                TextEdit {
                    Layout.fillWidth: true
                    visible: root.card == null && root.speech == null
                    text: root.placeholder
                    color: "#58F4F1"
                    textFormat: TextEdit.PlainText
                    wrapMode: TextEdit.Wrap
                    readOnly: true
                    selectByMouse: true
                    font.pixelSize: 17
                    Accessible.name: "Assistant response"
                }
            }
        }
    }
}
