import { redirect } from "next/navigation";

export const metadata = { title: "Humane Center" };

/**
 * Bare `/settings/account` — nothing in the nav links here (the group links go
 * straight to Details/Plan/Orders), but a deep link or a trimmed URL should land
 * somewhere real rather than 404. Details is the account section's first pane.
 */
export default function AccountIndex() {
  redirect("/settings/account/details");
}
