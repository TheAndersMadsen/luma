/*
 * /settings/updates, Settings → Advanced → Software updates. Operator only:
 * middleware refuses the path first (`isOperatorPath`), and the page decides
 * again from the session. Server-rendered so it is useful without
 * JavaScript; "Check now" is a plain form post.
 */

import type { Metadata } from "next";

import { OPERATOR_UPDATES_PATH } from "@/server/auth";
import { updateOverview } from "@/server/domain/updates";
import { requireOperatorSession } from "@/server/operator";
import { UpdatesPane } from "./UpdatesPane";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Software updates" };

export default async function UpdatesPage() {
  await requireOperatorSession(OPERATOR_UPDATES_PATH);
  return <UpdatesPane overview={await updateOverview()} />;
}
