import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// An immutable text snapshot. No markup, links, web view or external opener.
// Readiness is checked during layout and committed after the painted frame.
Rectangle {
    id: root
    required property var document
    property string documentKey: document ? document.actionId + document.digest : ""
    property bool positioned: false
    color: theme.surface
    radius: 12
    border.color: theme.accent
    border.width: 1

    function locate() {
        positioned = false
        if (!document || editor.text !== document.text || scroller.height <= 0) return
        editor.cursorPosition = document.cursor
        const rect = editor.positionToRectangle(document.cursor)
        scroller.contentY = Math.max(0, Math.min(rect.y - 12, scroller.contentHeight - scroller.height))
        positioned = true
    }
    function prepareFrame() {
        if (!document || !document.pending || !positioned || !visible || !window.visible || !window.active
                || backend.state.ceremony != null
                || editor.text !== document.text || editor.cursorPosition !== document.cursor) return
        const rect = editor.positionToRectangle(document.cursor)
        if (scroller.width > 0 && scroller.height > 0 && rect.height > 0
                && rect.y >= scroller.contentY && rect.y + rect.height <= scroller.contentY + scroller.height) {
            backend.documentRendered(document.actionId, document.digest, document.line)
        }
    }
    onDocumentKeyChanged: Qt.callLater(locate)
    onWidthChanged: Qt.callLater(locate)
    onHeightChanged: Qt.callLater(locate)
    Component.onCompleted: Qt.callLater(locate)
    Connections {
        target: window
        function onAfterAnimating() { root.prepareFrame() }
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 16
        spacing: 10
        RowLayout {
            Layout.fillWidth: true
            Label {
                Layout.fillWidth: true
                text: root.document ? root.document.label : ""
                textFormat: Text.PlainText
                color: theme.primary
                font.bold: true
                elide: Text.ElideRight
            }
            Label {
                text: root.document ? "Read-only · Line " + root.document.line : ""
                color: theme.secondary
                font.pixelSize: 12
            }
            CosmosButton {
                text: "Close document"
                implicitHeight: 30
                onClicked: backend.closeDocument()
            }
        }
        Flickable {
            id: scroller
            Layout.fillWidth: true
            Layout.fillHeight: true
            contentWidth: width
            contentHeight: editor.height
            boundsBehavior: Flickable.StopAtBounds
            clip: true
            ScrollBar.vertical: ScrollBar { }
            TextEdit {
                id: editor
                objectName: "documentText"
                width: scroller.width - 12
                height: Math.max(contentHeight, scroller.height)
                text: root.document ? root.document.text : ""
                textFormat: TextEdit.PlainText
                wrapMode: TextEdit.WrapAnywhere
                readOnly: true
                selectByMouse: true
                color: theme.primary
                font.family: "monospace"
                font.pixelSize: 14
                Accessible.name: "Document snapshot"
            }
        }
    }
}
