import { PublicPage, publicPageMetadata } from "@/components/PublicPage";

export const metadata = publicPageMetadata("/contact");

export default function ContactPage() {
  return <PublicPage path="/contact" />;
}
