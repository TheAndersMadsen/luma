import { redirect } from "next/navigation";

import { OPERATOR_PROVISIONING_PATH } from "@/server/auth";
import { requireOperatorSession } from "@/server/operator";

export const dynamic = "force-dynamic";

/** Keep old bookmarks working while provisioning now lives inside Settings. */
export default async function AdminPage() {
  await requireOperatorSession("/admin");
  redirect(OPERATOR_PROVISIONING_PATH);
}
