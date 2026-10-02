import { redirect } from "next/navigation";

/**
 * humane.center/devices, where the stock Pin sends a wearer to turn block mode
 * off ("This Ai Pin is in block mode. Visit humane.center/devices to disable
 * this mode", `humane_answers` `blocked_device`).
 */
export default function DevicesPage() {
  redirect("/settings/account/devices");
}
