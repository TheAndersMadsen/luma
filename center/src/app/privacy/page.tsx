import { PublicPage, publicPageMetadata } from "@/components/PublicPage";

export const metadata = publicPageMetadata("/privacy");

export default function PrivacyPage() {
  return <PublicPage path="/privacy" />;
}
