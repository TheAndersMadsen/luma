import { redirect } from "next/navigation";

/** Legacy links open the contextual assistant instead of a competing page. */
export default function TalkPage() {
  redirect("/?assistant=open");
}
