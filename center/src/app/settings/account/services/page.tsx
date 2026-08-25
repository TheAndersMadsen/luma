import { CosmosServicesCard } from "./CosmosServicesCard";
import { SpotifyServiceCard } from "./SpotifyServiceCard";

export const metadata = { title: "Services · Ai Pin Revival Center" };

export default function ServicesPage() {
  return (
    <>
      <CosmosServicesCard />
      <SpotifyServiceCard />
    </>
  );
}
