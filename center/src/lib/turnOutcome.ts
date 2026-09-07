import type { PrivacyClass, TurnStatus } from "./contracts/ambianceRuntime";

/** Kinds of device in the owner's words. Cosmos names a kind, never which one or who saw it. */
export const DEVICE: Record<string, string> = {
  browser: "a browser", macos: "your Mac", linux: "your Linux PC", android: "your phone", android_tv: "your TV", pin: "your Ai Pin",
};
export const device = (platform: string | null | undefined) => (platform && DEVICE[platform]) ?? "a device";
/** The same kinds counted, so two browser tabs read as "2 browsers" rather than as the same sentence twice. */
const DEVICE_PLURAL: Record<string, string> = {
  browser: "browsers", macos: "Macs", linux: "Linux PCs", android: "phones", android_tv: "TVs", pin: "Ai Pins",
};
export const devices = (platform: string | null | undefined, count: number) =>
  count === 1 ? device(platform) : `${count} ${(platform && DEVICE_PLURAL[platform]) ?? "devices"}`;
export const where = (platform: string | null | undefined) => `${platform === "browser" ? "in" : "on"} ${device(platform)}`;
/** Classes above the shared-room ceiling reach only a personal device the owner declared for them. */
export const privateClass = (privacy: PrivacyClass) => privacy === "near_user" || privacy === "private" || privacy === "sensitive";
/** What the class meant, as a sentence. The owner never reads the class name itself. */
export const CLASS: Record<PrivacyClass, string> = {
  public: "This reply was safe for anyone to see.",
  shared_room: "This reply was safe to show on a screen other people can see.",
  near_user: "This reply was only for a screen right beside you.",
  private: "This reply was private to you.",
  sensitive: "This reply was too sensitive for any screen.",
};

/**
 * A headline from the shared state vocabulary and one plain sentence under it —
 * the same two-part line the Mac, Linux, phone and TV clients show, so a turn
 * reads the same wherever the owner happens to be looking.
 */
export interface StatusLine { title: string; detail: string }
export const NO_STATUS: StatusLine = { title: "", detail: "" };
export const statusLine = (title: string, detail = ""): StatusLine => ({ title, detail });
export const statusText = ({ title, detail }: StatusLine) => [title, detail].filter(Boolean).join(" · ");

/** One turn, for the surface that asked: Working, Waiting for a device, Completed · Shown on your Mac, Cannot confirm. */
export function describeTurn(status: Pick<TurnStatus, "state" | "surface" | "privacy">, here = "browser"): StatusLine {
  const platform = status.surface?.platform ?? null;
  const mine = platform !== null && platform === here;
  switch (status.state) {
    case "working": return statusLine("Working");
    case "waiting": return mine ? statusLine("Waiting for you", "Bring this tab to the front to see the reply")
      : platform === null ? statusLine("Waiting for a device")
        : statusLine("Waiting for a device", `Waiting for ${device(platform)}`);
    // A command is waiting for the owner's confirmation at the device that
    // would carry it out. Closing a panel is not answering it.
    case "confirming": return statusLine("Waiting for you", platform === null ? "Confirm it on the device that would do it"
      : `Confirm it ${where(platform)}`);
    // An approved device is carrying a command out. Nothing is claimed yet.
    case "acting": return statusLine("Working", platform === null ? "A device is working on it" : `Working ${where(platform)}`);
    case "shown": return mine ? statusLine("Completed", "Shown in this browser")
      : statusLine("Completed", `${privateClass(status.privacy) ? "Private reply" : "Shown"} ${where(platform)}`);
    case "spoken": return statusLine("Completed", `Spoken ${where(platform)}`);
    // A device reported that it carried the command out.
    case "done": return statusLine("Completed", `Done ${where(platform)}`);
    // A device reported that it did not. The origin never learns why.
    case "refused": return statusLine("Not done", `Nothing happened ${where(platform)}`);
    case "nowhere": return statusLine("Cannot confirm", "Nothing could show or say the reply. It was not sent again.");
    default: return statusLine("Cannot confirm");
  }
}
