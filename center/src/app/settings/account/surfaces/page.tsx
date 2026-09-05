import { redirect } from "next/navigation";
import { currentSession } from "@/server/operator";
import { AUTH_ENABLED } from "@/server/auth";
import { Surfaces } from "./Surfaces";
import { NativeSurfaces } from "./NativeSurfaces";
export const metadata = { title: "Surfaces · Ai Pin Revival Center" };
export default async function SurfacesPage() {
  if (!AUTH_ENABLED || !await currentSession()) redirect("/login?next=%2Fsettings%2Faccount%2Fsurfaces");
  return <><Surfaces /><NativeSurfaces /></>;
}
