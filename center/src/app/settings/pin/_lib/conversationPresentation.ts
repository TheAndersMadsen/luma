import type {
  ConversationMessage,
  ConversationSummary,
  PaginatedConversations,
} from "@/lib/pin-device";

/*
 * The device's own conversation log, as a list Center can page through.
 *
 * What the Pin stores per turn is narrower than the word "conversation"
 * suggests, and the UI has to be honest about it. `save_understand_conversation`
 * takes the model history and drops it: the row keeps the wearer's utterance and
 * the assistant's final reply, and that is all
 * (pin/runtime/core/src/db.rs). So a "conversation" here is one turn — a thing
 * said and a thing answered — not a transcript with a system preamble in it.
 *
 * The store is also bounded on the device: seven days, and at most a thousand
 * turns, pruned on every write. Center never sees what fell off the end, so the
 * pane says so rather than presenting a short list as a complete history.
 */

/** Turns per request. The Pin clamps its own limit to 200; this stays well under. */
export const CONVERSATION_PAGE_SIZE = 25;

/** Seven days, from CONVERSATION_RETENTION_SECS in the Pin's db module. */
export const CONVERSATION_RETENTION_DAYS = 7;

/** CONVERSATION_ROW_LIMIT, likewise. */
export const CONVERSATION_ROW_LIMIT = 1_000;

/**
 * The roles that reach a stored thread.
 *
 * `assistant_decline` is a server-generated failure notice, kept out of the
 * model's own context on purpose (see DECLINE_MESSAGE_ROLE). Rendering it as a
 * plain assistant reply would show the wearer the Pin apologising in its own
 * voice for something it never said.
 */
export function conversationRoleLabel(role: string): string {
  switch (role) {
    case "assistant":
      return "Ai Pin";
    case "assistant_decline":
      return "Ai Pin — could not answer";
    case "user":
      return "You";
    case "system":
      return "System";
    default:
      return role;
  }
}

/** A decline is the one role that reads as a failure rather than an answer. */
export function isDeclineMessage(message: ConversationMessage): boolean {
  return message.role === "assistant_decline";
}

export interface ConversationListState {
  readonly items: readonly ConversationSummary[];
  /** What to send as `offset` next. Counts rows RECEIVED, not rows kept. */
  readonly offset: number;
  /** The Pin says another page may exist. */
  readonly hasMore: boolean;
}

export const EMPTY_CONVERSATION_LIST: ConversationListState = {
  items: [],
  offset: 0,
  hasMore: true,
};

/**
 * Fold one answered page into the list.
 *
 * Two device behaviours make this more than a concatenation:
 *
 *  - The Pin reports `has_more` as "this page came back exactly full", so the
 *    last page of an exact multiple is followed by an empty one. An empty page
 *    is the end, whatever the flag says, or the pane offers "Load older"
 *    forever.
 *
 *  - Offset paging over `ORDER BY created_at DESC, id DESC` is not stable while
 *    the wearer is still talking to the Pin. A turn recorded between two page
 *    reads pushes a row across the boundary and it arrives twice. Keeping the
 *    first copy holds the list in the order the device sent it, and keeps React
 *    from rendering two rows under one key.
 *
 * The offset still advances by the number of rows RECEIVED. Advancing by rows
 * KEPT would re-request the overlap on every press and never reach the end.
 */
export function appendConversationPage(
  state: ConversationListState,
  page: PaginatedConversations,
): ConversationListState {
  const received = page.conversations;
  const seen = new Set(state.items.map((item) => item.id));
  const added = received.filter((item) => !seen.has(item.id));

  return {
    items: added.length > 0 ? [...state.items, ...added] : state.items,
    offset: state.offset + received.length,
    hasMore: received.length > 0 && page.has_more,
  };
}

/**
 * A one-line preview of what the wearer said.
 *
 * Utterances are whole sentences and the list is a scan surface, so long ones
 * are cut at a word boundary. An utterance that is only whitespace — the device
 * records the turn even when transcription produced nothing usable — gets a
 * stated absence rather than an empty row that reads as a rendering bug.
 */
export function conversationPreview(utterance: string, maxLength = 120): string {
  const collapsed = utterance.replace(/\s+/g, " ").trim();
  if (!collapsed) return "No transcript for this turn";
  if (collapsed.length <= maxLength) return collapsed;
  const clipped = collapsed.slice(0, maxLength);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${(lastSpace > maxLength / 2 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
}

/**
 * The Pin's conversation ids are SQLite rowids, so a route parameter has to be
 * proved to be one before it is put in a path. Returns null for anything else.
 */
export function parseConversationId(value: string): number | null {
  if (!/^[1-9]\d{0,15}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
