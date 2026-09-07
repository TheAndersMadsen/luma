import { redirect } from "next/navigation";
import { currentSession } from "@/server/operator";
import { AUTH_ENABLED } from "@/server/auth";
import { readActivity } from "@/server/activity";
import { ActivityList } from "./ActivityList";
export const dynamic = "force-dynamic";
export const metadata = { title: "Activity · Ai Pin Revival Center" };
export default async function ActivityPage() {
  if (!AUTH_ENABLED || !await currentSession()) redirect("/login?next=%2Fsettings%2Faccount%2Factivity");
  const activity = await readActivity();
  if (activity.state === "expired") redirect("/login?next=%2Fsettings%2Faccount%2Factivity");
  return <ActivityList activity={activity} />;
}
