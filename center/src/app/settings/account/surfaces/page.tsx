import { redirect } from "next/navigation";
import { currentSession } from "@/server/operator";
import { AUTH_ENABLED } from "@/server/auth";
import { Devices } from "./Devices";
export const metadata = { title: "Devices · Ai Pin Revival Center" };
export default async function DevicesPage() {
  if (!AUTH_ENABLED || !await currentSession()) redirect("/login?next=%2Fsettings%2Faccount%2Fsurfaces");
  return <Devices />;
}
