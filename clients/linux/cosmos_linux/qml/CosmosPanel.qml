import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// The response surface from the Omarchy kit. It shows what Cosmos decided and
// nothing else: the Now line for the request just sent, the delivered card
// verbatim (text, places with inert credits, or a numbered choice list), the
// spoken reply, or the empty state with three prompts that work today.
Item {
    id: root
    property var s: backend.state
    property bool motionEnabled: true
    property var card: null
    property var speech: null
    property bool speaking: false
    property string sentText: ""
    property bool empty: card == null && speech == null && sentText.length === 0
    signal choicePicked(int index)
    signal examplePicked(string text)
    implicitWidth: 640
    implicitHeight: 330

    function focusChoices() { if (choices.visible) choices.focusList() }

    BorderImage {
        anchors.fill: parent
        visible: theme.dark
        source: "../assets/panel-frame.png"
        border.left: 34; border.right: 34
        border.top: 34; border.bottom: 34
    }
    Rectangle {
        anchors.fill: parent
        anchors.margins: 20
        visible: !theme.dark
        radius: theme.panelRadius
        color: theme.panel
        border.color: theme.border
        border.width: 1
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 42
        spacing: 12

        // The Now line: what was sent, the instant it was sent.
        RowLayout {
            Layout.fillWidth: true
            Layout.maximumWidth: theme.maxLineWidth
            spacing: 10
            visible: root.sentText.length > 0
            Label {
                text: S.NOW
                color: theme.secondary
                font.pixelSize: 12
                font.weight: Font.DemiBold
                Layout.alignment: Qt.AlignTop
                topPadding: 2
            }
            TextEdit {
                Layout.fillWidth: true
                text: root.sentText
                color: theme.primary
                font.pixelSize: theme.body - 1
                textFormat: TextEdit.PlainText
                wrapMode: TextEdit.Wrap
                readOnly: true
                selectByMouse: true
                Accessible.name: S.NOW + ": " + root.sentText
            }
            Rectangle {
                visible: root.card != null && root.card.private === true
                Layout.alignment: Qt.AlignTop
                radius: height / 2
                color: theme.surface
                border.color: theme.accent
                border.width: 1
                implicitHeight: 22
                implicitWidth: privateLabel.implicitWidth + 16
                Label {
                    id: privateLabel
                    anchors.centerIn: parent
                    text: S.PRIVATE_REPLY
                    color: theme.response; font.pixelSize: 11
                }
            }
        }

        ScrollView {
            id: scroller
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true
            contentWidth: availableWidth
            // A long reply scrolls inside the card. The style's own rail is kept, because
            // only that one is laid out by ScrollView, and it is held open while there is
            // more to see so nothing is hidden without a sign.
            Binding {
                target: scroller.ScrollBar.vertical
                property: "policy"
                value: (scroller.ScrollBar.vertical.size > 0 && scroller.ScrollBar.vertical.size < 1)
                       ? ScrollBar.AlwaysOn : ScrollBar.AsNeeded
            }

            ColumnLayout {
                width: Math.min(scroller.availableWidth, theme.maxLineWidth)
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
                    Accessible.name: "Cosmos reply"
                    opacity: root.card != null ? 1 : 0
                    Behavior on opacity { NumberAnimation { duration: window.motionMs; easing.type: Easing.OutCubic } }

                    ColumnLayout {
                        id: cardColumn
                        width: parent.width
                        spacing: 8

                        TextEdit {
                            Layout.fillWidth: true
                            visible: root.card != null && root.card.kind === "text"
                            text: root.card && root.card.kind === "text" ? root.card.text : ""
                            color: theme.response
                            textFormat: TextEdit.PlainText
                            wrapMode: TextEdit.Wrap
                            readOnly: true
                            selectByMouse: true
                            font.pixelSize: theme.body
                            Accessible.name: "Cosmos reply text"
                        }

                        ChoiceList {
                            id: choices
                            Layout.fillWidth: true
                            visible: root.card != null && root.card.kind === "choices"
                            title: root.card && root.card.kind === "choices" ? root.card.title : ""
                            items: root.card && root.card.kind === "choices" ? root.card.items : []
                            enabled: root.s.canSend
                            onPicked: function(index) { root.choicePicked(index) }
                        }

                        Label {
                            Layout.fillWidth: true
                            visible: root.card != null && root.card.kind === "places"
                            text: root.card && root.card.kind === "places" ? root.card.query : ""
                            color: theme.primary; font.pixelSize: theme.body; font.weight: Font.DemiBold
                            wrapMode: Text.Wrap
                        }
                        Label {
                            visible: root.card != null && root.card.kind === "places" && root.card.items.length === 0
                            text: S.NO_PLACES
                            color: theme.response; font.pixelSize: theme.body - 1
                        }
                        Repeater {
                            model: root.card && root.card.kind === "places" ? root.card.items : []
                            delegate: ColumnLayout {
                                required property var modelData
                                Layout.fillWidth: true
                                spacing: 2
                                Label { text: modelData.name; color: theme.primary; font.pixelSize: theme.body - 1; font.weight: Font.DemiBold; wrapMode: Text.Wrap; Layout.fillWidth: true }
                                Label { text: modelData.address; color: theme.response; font.pixelSize: theme.body - 2; wrapMode: Text.Wrap; Layout.fillWidth: true }
                                Label {
                                    visible: modelData.sourceUrl.length > 0
                                    text: "<a href=\"" + modelData.sourceUrl + "\">" + S.VIEW_ON_MAPS + "</a>"
                                    textFormat: Text.StyledText
                                    linkColor: theme.accent
                                    font.pixelSize: 14
                                    Accessible.name: S.VIEW_ON_MAPS + ": " + modelData.name
                                    onLinkActivated: function(link) { backend.openLink(link) }
                                }
                            }
                        }
                        Repeater {
                            model: root.card && root.card.kind === "places" ? root.card.creditLines : []
                            delegate: Label {
                                required property var modelData
                                Layout.fillWidth: true
                                text: modelData
                                textFormat: Text.StyledText
                                linkColor: theme.accent
                                color: theme.secondary; font.pixelSize: 12
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
                        text: root.speaking ? S.SPEAKING : S.SPOKEN_REPLY
                        color: theme.secondary; font.pixelSize: 12; font.weight: Font.DemiBold
                    }
                    TextEdit {
                        Layout.fillWidth: true
                        text: root.speech ? root.speech.text : ""
                        color: theme.primary
                        textFormat: TextEdit.PlainText
                        wrapMode: TextEdit.Wrap
                        readOnly: true
                        selectByMouse: true
                        font.pixelSize: theme.body - 1
                        Accessible.name: S.SPOKEN_REPLY
                    }
                }

                // Empty state: the nebula behind the window, three prompts that work today.
                ColumnLayout {
                    Layout.fillWidth: true
                    visible: root.empty
                    spacing: 12
                    Label {
                        text: S.EMPTY_TITLE
                        color: theme.primary
                        font.pixelSize: 22
                        font.weight: Font.DemiBold
                    }
                    Label {
                        Layout.fillWidth: true
                        text: root.s.connected ? S.CONNECTED_BODY : root.s.statusText
                        color: theme.secondary
                        font.pixelSize: theme.body - 2
                        wrapMode: Text.Wrap
                    }
                    Flow {
                        Layout.fillWidth: true
                        spacing: 8
                        Repeater {
                            model: root.s.examplePrompts
                            delegate: Chip {
                                required property var modelData
                                text: modelData
                                enabled: root.s.canSend
                                onClicked: root.examplePicked(modelData)
                            }
                        }
                    }
                }
            }
        }
    }
}
