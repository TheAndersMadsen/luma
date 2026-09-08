import AppKit
import SwiftUI

/// A read-only native text view. Unlike handing a pathname to another app, it
/// can observe the exact retained version and line it drew.
struct DocumentView: NSViewRepresentable {
    let presentation: DocumentPresentation
    let committed: @MainActor (UUID, String, UInt32) -> Bool

    func makeNSView(context: Context) -> DocumentScrollView {
        let scroll = DocumentScrollView()
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = false
        scroll.drawsBackground = false
        let text = SnapshotTextView(frame: .zero)
        text.isEditable = false
        text.isSelectable = true
        text.isRichText = false
        text.isAutomaticLinkDetectionEnabled = false
        text.isAutomaticDataDetectionEnabled = false
        text.drawsBackground = false
        text.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        text.textColor = .labelColor
        text.textContainerInset = NSSize(width: 12, height: 12)
        text.isVerticallyResizable = true
        text.isHorizontallyResizable = false
        text.autoresizingMask = [.width]
        text.textContainer?.widthTracksTextView = true
        text.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
        scroll.documentView = text
        return scroll
    }

    func updateNSView(_ scroll: DocumentScrollView, context: Context) {
        guard let text = scroll.documentView as? SnapshotTextView else { return }
        text.committed = committed
        if text.presentation != presentation {
            text.presentation = presentation
            text.string = presentation.content.text
            text.didCommit = false
            scroll.positioned = false
        }
        scroll.needsLayout = true
        text.needsDisplay = true
    }

    static func dismantleNSView(_ scroll: DocumentScrollView, coordinator: ()) {
        guard let text = scroll.documentView as? SnapshotTextView else { return }
        text.committed = nil
        text.presentation = nil
        text.string = ""
    }
}

final class DocumentScrollView: NSScrollView {
    var positioned = false

    override func layout() {
        super.layout()
        guard !positioned, contentSize.width > 0, contentSize.height > 0,
              let text = documentView as? SnapshotTextView, let snapshot = text.presentation?.content else { return }
        text.setFrameSize(NSSize(width: contentSize.width, height: max(text.frame.height, contentSize.height)))
        text.textContainer?.containerSize.width = contentSize.width - 2 * text.textContainerInset.width
        if let container = text.textContainer { text.layoutManager?.ensureLayout(for: container) }
        text.setSelectedRange(NSRange(location: snapshot.cursor, length: 0))
        text.scrollRangeToVisible(NSRange(location: snapshot.cursor, length: 0))
        positioned = true
        text.needsDisplay = true
    }
}

final class SnapshotTextView: NSTextView {
    var presentation: DocumentPresentation?
    var committed: (@MainActor (UUID, String, UInt32) -> Bool)?
    var didCommit = false
    private var observing = false

    func showsRequestedLine() -> Bool {
        guard let snapshot = presentation?.content, string == snapshot.text,
              let window, window.isVisible, !window.isMiniaturized, window.occlusionState.contains(.visible),
              !isHiddenOrHasHiddenAncestor, let layoutManager, let textContainer,
              let scroll = enclosingScrollView as? DocumentScrollView, scroll.positioned else { return false }
        layoutManager.ensureLayout(for: textContainer)
        let rect: NSRect
        if snapshot.cursor < string.utf16.count {
            let glyph = layoutManager.glyphIndexForCharacter(at: snapshot.cursor)
            rect = layoutManager.lineFragmentUsedRect(forGlyphAt: glyph, effectiveRange: nil)
        } else {
            rect = layoutManager.extraLineFragmentRect
        }
        let origin = textContainerOrigin
        let start = NSRect(x: rect.minX + origin.x, y: rect.minY + origin.y,
                           width: 1, height: rect.height)
        return start.height > 0 && visibleRect.contains(start)
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard !didCommit, !observing, showsRequestedLine(), let current = presentation else { return }
        observing = true
        // Publishing model state inside draw would invalidate the same frame.
        // Recheck the actual view and binding when that draw has returned.
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            observing = false
            guard presentation == current, showsRequestedLine() else { return }
            didCommit = committed?(current.task.actionID, current.content.digest, current.content.line) ?? false
        }
    }
}
