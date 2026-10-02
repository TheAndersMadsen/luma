import { CosmosServicesCard } from "./CosmosServicesCard";
import { GuidedSetupReturn } from "@/components/GuidedSetupReturn";
import { currentSession } from "@/server/operator";

export const metadata = { title: "Assistant & voice" };

export default async function ServicesPage() {
  const session = await currentSession();
  return (
    <>
      <CosmosServicesCard operator={session?.operator === true} />
      <GuidedSetupReturn />
    </>
  );
}
