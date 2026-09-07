"""Every word the owner reads, in one place.

The state vocabulary and the sentences under it are fixed by the Cosmos client
brief; the other clients carry the same words. QML reads this module through
the ``S`` context property, so a wording change happens here only.
"""
from __future__ import annotations

APP_NAME = "Cosmos"

# -- the state vocabulary ----------------------------------------------------
# This client never listens, so "Listening" is not one of its states.
WORKING = "Working"
WAITING_FOR_YOU = "Waiting for you"
WAITING_FOR_DEVICE = "Waiting for a device"
COMPLETED = "Completed"
CANNOT_CONFIRM = "Cannot confirm"
DISCONNECTED = "Disconnected"
# A device action that did not happen. One sentence on what happened, one on
# what to do; never a reason that belongs to someone else's device.
NOT_DONE = "Not done"

# -- sub-lines: plain sentences ---------------------------------------------
RECONNECTING = "Reconnecting…"
CONNECTING = "Connecting…"
CONNECTED = "Connected"
DISCONNECTING = "Disconnecting…"
SETTING_UP = "Setting up this computer…"
SPEAKING_HERE = "Speaking the reply here."
WAITING_HERE = "Bring this window to the front to see the reply."
CANNOT_CONFIRM_DETAIL = "Nothing could show or say the reply. It was not sent again."
SHOWN_ON = "Shown on your {device}"
SPOKEN_ON = "Spoken on your {device}"
WAITING_FOR = "Waiting for your {device}"
DONE_ON = "Done on your {device}"
ACTING_ON = "Your {device} is doing it"
ACTING_HERE = "This computer is doing it"
CONFIRM_HERE = "Confirm it on this computer"
NOT_DONE_ELSEWHERE = "That did not happen. Ask again if you still want it."

# Friendly names for the kinds of device Cosmos names in a status.
DEVICE_NAMES = {
    "macos": "MacBook",
    "android": "phone",
    "android_tv": "TV",
    "browser": "browser",
    "linux": "Linux PC",
    "pin": "Ai Pin",
}
A_DEVICE = "a device"

# -- destinations ------------------------------------------------------------
THIS_SCREEN = "This screen"
DESTINATION_CHIP = "→ {name}"
DESTINATION_NAMES = {
    "linux": THIS_SCREEN,
    "macos": "MacBook Pro",
    "android": "Pixel 10 Pro",
    "android_tv": "Shield TV",
}
OFFLINE = "offline"
DESTINATION_TITLE = "Send to"

# -- context chip ------------------------------------------------------------
USE_SELECTION = "Use selection"
USING_SELECTION = "Using: {app} selection"
CAPTURING_SELECTION = "Reading the selection…"
NO_SELECTION = "Nothing is selected. Select some text, then try again."
UNKNOWN_APP = "Unknown app"
SCREEN_CONTEXT_OFF = "Screen context is off. Turn it on in Center → Devices."
OPEN_CENTER_DEVICES = "Open Center → Devices"
DROP_CONTEXT = "Remove the attached selection"

# -- setup and approval -------------------------------------------------------
SETUP_TITLE = "Set up this computer"
SETUP_BODY = ("Cosmos will know this computer as one of your devices. It sends what you type here, "
              "shows replies and speaks them while this window is open. It never listens, and it never "
              "reads your screen unless you attach a selection.")
SETUP_ACTION = "Set up this computer"
SETUP_WORKING = "Setting up…"
SERVER_LABEL = "Center"
SERVER_CHANGE = "Change"
SERVER_USE = "Use this Center"
SERVER_KEEP = "Keep current"
SERVER_PLACEHOLDER = "https://center.example"
APPROVAL_TITLE = "Approve in Center"
APPROVAL_BODY = ("Scan the code with your phone, or open the link on this computer. Center shows the same "
                 "fingerprint as below. Approve there and this window connects by itself.")
APPROVAL_OPEN = "Open in browser"
APPROVAL_WAITING = "Waiting for your approval in Center…"
APPROVAL_CONNECT = "Connect now"
FINGERPRINT_LABEL = "Fingerprint"
COPY_LINK = "Copy link"
COPY_DESCRIPTOR = "Copy descriptor"
COPIED = "Copied"
CHANGE_SERVER = "Change Center"
DETAILS = "Details"
HIDE_DETAILS = "Hide details"
CONNECTED_BODY = "Ask anything. Replies appear here or on the device that suits them best."

# -- connected view ----------------------------------------------------------
PROMPT_PLACEHOLDER = "Ask Cosmos…"
PROMPT_WAITING = "Waiting for the connection…"
SEND = "Send"
CLOSE = "Close"
CANCEL_TASK = "Cancel task"
RETRY = "Retry"
DISCONNECT = "Disconnect"
CONNECT = "Connect"
QUIT = "Quit"
NOW = "Now"
REDUCE_MOTION = "Reduce motion"
PRIVATE_REPLY = "Private reply"
SPOKEN_REPLY = "Spoken reply"
SPEAKING = "Speaking"
NO_PLACES = "No matching places found."
VIEW_ON_MAPS = "View on Google Maps"
EMPTY_TITLE = "Ask anything"
EXAMPLE_CAFES = "Find cafés near me"
EXAMPLE_NOTES = "Show my notes about the kitchen"
EXAMPLE_SCREEN = "What's on my screen?"
SHORTCUTS_CONNECTED = ("Ctrl+L ask · Enter send · Ctrl+Return send from anywhere · Esc close · "
                       "Ctrl+. cancel task · 1–8 pick")
SHORTCUTS_SETUP = "Ctrl+L focus · Esc close · Ctrl+Q quit"
PREVIEW = "Preview"

# -- device actions ----------------------------------------------------------
# Cosmos may ask this computer to open something. It says what it is doing,
# how long it has been doing it, and afterwards only what it actually saw.
TASK_OPENING = "Opening {label}"
TASK_OPENED = "{label} is open on this computer."
TASK_OPENED_PLAIN = "It is open on this computer."
TASK_UNKNOWN = "This computer cannot confirm that {label} opened. It was not opened again."
TASK_UNKNOWN_PLAIN = "This computer cannot confirm that it opened. It was not opened again."
TASK_STOPPED = "It was stopped."
TASK_STOPPED_REMEDY = "Ask again if you still want it."
TASK_FAILED = "That did not open on this computer."
TASK_FAILED_REMEDY = "Try again, or open it yourself."
CANCEL_TASK_HINT = "Ctrl+."
TASK_CLOSE_NOTE = "Closing hides this window. The task keeps running."

# Why a command was refused here, and what the owner can do about it. Never a
# reason about another device, and never a reason about privacy.
REFUSAL_NO_HANDLER = "This computer has no application set up to open that."
REFUSAL_NO_HANDLER_REMEDY = "Add an opener to device-actions.json in the Cosmos data folder, then ask again."
REFUSAL_NOT_PERMITTED = "This computer is not allowed to open that."
REFUSAL_NOT_PERMITTED_REMEDY = "Add it to device-actions.json in the Cosmos data folder, then ask again."
REFUSAL_UNRESOLVABLE = "That document is not in the folder this computer knows by that name."
REFUSAL_UNRESOLVABLE_REMEDY = "Check the folder in device-actions.json, then ask again."
REFUSAL_VERSION_CHANGED = "That document changed since it was read. It was not opened."
REFUSAL_VERSION_CHANGED_REMEDY = "Ask again to open the version this computer has."
# The three operations this platform does not offer at all.
UNSUPPORTED_RUN = "This computer does not run commands."
UNSUPPORTED_ROUTE = "This computer does not start navigation."
UNSUPPORTED_PLAY = "This computer does not play media."
UNSUPPORTED_OTHER = "This computer cannot do that."
UNSUPPORTED_REMEDY = "Ask for it on a device that can."
POLICY_MISSING = "This computer is not set up to open anything yet."
POLICY_MISSING_REMEDY = "Write device-actions.json in the Cosmos data folder to allow a site or a folder."
POLICY_INVALID = "This computer could not read what it is allowed to open, so it will open nothing."
POLICY_INVALID_REMEDY = "Fix device-actions.json in the Cosmos data folder, then restart Cosmos."

# The ceremony. The runtime composed these words from the owner's own label;
# this file only frames them.
CONFIRM_TITLE = "Confirm on this computer"
CONFIRM_QUESTION = "{verb} {subject} on this computer?"
CONFIRM_CLASS_PRIVATE = "This is private to you."
CONFIRM_ALLOW = "Confirm"
CONFIRM_DECLINE = "Decline"
CONFIRM_COUNTDOWN = "{seconds}s left"
CONFIRM_HINT = "Enter confirms · Esc dismisses without answering"
CONFIRM_HINT_DECLINE_ONLY = "Esc dismisses without answering"
CONFIRM_CANNOT = "This computer cannot prove who you are, so it cannot confirm this."
CONFIRM_DISMISSED = "Nothing was answered. The request runs out on its own."
CONFIRM_DECLINED = "You said no."
CONFIRM_EXPIRED = "The confirmation ran out."

# -- notices: one sentence on what happened, one on what to do -----------------
NOTICE_PREPARED = "This computer is ready. Approve it in Center to connect."
NOTICE_CONNECTED = "Connected to Cosmos."
NOTICE_SENT = "Cosmos has your request."
NOTICE_CANCELLED = "The task was cancelled."
NOTICE_DISCONNECTED = "Disconnected. Your approval in Center still stands."
NOTICE_RETRIED = "Cosmos confirmed the earlier request."
NOTICE_DROPPED = "The connection dropped. Reconnecting…"
NOTICE_CARD = "A reply is on this screen."
NOTICE_PRIVATE_CARD = "A private reply is on this screen. It stays only while this window is in front."
NOTICE_INVITATION = "A private reply is waiting. Keep this window in front to see it."
NOTICE_SPEAKING = "Cosmos is speaking the reply here."
NOTICE_TASK = "Cosmos asked this computer to open something."
NOTICE_TASK_WAITING = "Something is ready for this computer. Keep this window in front to carry it out."
NOTICE_CONFIRM = "Cosmos needs your answer on this computer."
NOTICE_PENDING = "The last request may or may not have gone through. Retry it before sending anything else."
NOTICE_UNKNOWN_OUTCOME = "An earlier request has an unknown outcome. It was not sent again."

# -- failures ------------------------------------------------------------------
FAIL_INVALID_SERVER = "That is not a Center address. Enter an https:// address with nothing after the host."
FAIL_INVALID_TEXT = "That text cannot be sent. Keep it under 4,000 characters."
FAIL_INVALID_RESPONSE = "Cosmos sent something this client could not verify. Update the client and try again."
FAIL_IDENTITY_UNAVAILABLE = ("This computer's key could not be opened. Check the keyring, or reset the "
                             "installation to set it up again.")
FAIL_STORAGE_UNAVAILABLE = "Protected storage is unavailable. Check the Cosmos data directory, then try again."
FAIL_STORAGE_BLOCKED = "The last request could not be saved. Retry it before sending anything else."
FAIL_APPROVAL_REQUIRED = "This computer is not approved yet. Approve it in Center to connect."
FAIL_CONNECTION_UNAVAILABLE = "Cosmos could not be reached. Reconnecting…"
FAIL_UNCERTAIN_REQUEST = "The last request may or may not have gone through. Retry it before sending anything else."
FAIL_BUSY = "Cosmos is still busy with the last action. Wait a moment, then try again."
FAIL_FEATURE_UNAVAILABLE = "This needs a newer Cosmos client. Update the client and try again."
FAIL_ACTIONS_UNAVAILABLE = ("This build of Cosmos cannot carry out tasks on this computer. Nothing was opened. "
                            "Update the client.")
FAIL_SCREEN_CONTEXT_OFF = SCREEN_CONTEXT_OFF


def as_map() -> dict:
    """The upper-case names as a flat map for QML."""
    return {name: value for name, value in globals().items()
            if name.isupper() and isinstance(value, (str, dict))}
