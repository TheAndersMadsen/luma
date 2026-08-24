import { PublicPage, publicPageMetadata } from "@/components/PublicPage";

export const metadata = publicPageMetadata("/about");

export default function AboutPage() {
  return <PublicPage path="/about" />;
}
