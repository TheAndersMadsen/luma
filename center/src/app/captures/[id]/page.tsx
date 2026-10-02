import { Shell } from "@/components/Shell";
import styles from "@/components/views.module.css";
import { CaptureDetailBody } from "../CaptureDetail";

export const metadata = { title: "Humane Center" };

/**
 * Capture detail, the FULL-PAGE fallback (deep link / refresh). The soft-nav
 * lightbox lives in the @capturemodal parallel slot. Both render the same
 * <CaptureDetailBody>, so a refreshed capture looks identical to the modal.
 */
export default async function CaptureDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <Shell showNav={false}>
      <div className={styles.pageContainer}>
        <h1 className={styles.srOnly}>Capture</h1>
        <CaptureDetailBody uuid={id} mode="page" />
      </div>
    </Shell>
  );
}
