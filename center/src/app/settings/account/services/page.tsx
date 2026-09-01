import { CosmosServicesCard } from "./CosmosServicesCard";
import { SpotifyServiceCard } from "./SpotifyServiceCard";
import { GuidedSetupReturn } from "@/components/GuidedSetupReturn";
import { currentSession } from "@/server/operator";

export const metadata = { title: "Services · Ai Pin Revival Center" };

export default async function ServicesPage() {
  const session = await currentSession();
  return (
    <>
      <CosmosServicesCard operator={session?.operator === true} />
      <SpotifyServiceCard />
      <GuidedSetupReturn />
    </>
  );
}
