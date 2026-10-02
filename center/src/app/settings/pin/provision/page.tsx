import type { Metadata } from "next";

import { OPERATOR_PROVISIONING_PATH } from "@/server/auth";
import { requireOperatorSession } from "@/server/operator";
import ProvisioningView from "./ProvisioningView";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Provisioning",
};

export default async function ProvisioningPage() {
  await requireOperatorSession(OPERATOR_PROVISIONING_PATH);
  return <ProvisioningView />;
}
