import { PublicPage, publicPageMetadata } from "@/components/PublicPage";

export const metadata = publicPageMetadata("/developers");

export default function DevelopersPage() {
  return <PublicPage path="/developers" />;
}
