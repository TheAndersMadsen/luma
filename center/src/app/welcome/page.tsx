import { PublicPage, publicPageMetadata } from "@/components/PublicPage";

export const metadata = publicPageMetadata("/");

export default function WelcomePage() {
  return <PublicPage path="/" />;
}
