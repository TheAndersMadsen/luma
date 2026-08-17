import type { Metadata } from "next";
import { HumaneLogo } from "@/icons";
import { resolveSharedThumbnail } from "@/app/api/share/content";
import styles from "./share.module.css";

/*
 * PUBLIC share view (a marketed .Center capability).
 *
 * Opening a `/share/{token}` link shows a single shared memory with NO login —
 * the token is minted from the capture detail (GetMemoryShareLink) and resolved
 * here through GetShareLinkContents. This page renders only minimal chrome (the
 * Humane mark) around the thumbnail, and never crashes on failure.
 *
 * TWO failures, two sentences. The page used to render one — "This shared
 * memory is no longer available" — for a bad token, an UNIMPLEMENTED RPC, a
 * dead backend and a timeout alike, so a transport blip told the recipient the
 * wearer's memory was gone. `invalid` is a verdict on the link; `degraded` is
 * our end not answering, and gets a retry.
 *
 * Orchestrator note: `/share/**` must be allowlisted in src/middleware.ts so
 * this page (and its `/api/share/**` route) are reachable without a session.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Shared memory — Humane Center",
  // A share link is public-by-token, not public-to-crawlers.
  robots: { index: false, follow: false },
};

export default async function SharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const shared = await resolveSharedThumbnail(token);

  return (
    <main className={styles.stage}>
      <header className={styles.chrome}>
        <span className={styles.brand}>
          <HumaneLogo size={20} />
        </span>
      </header>

      {shared.status === "ok" ? (
        <figure className={styles.frame}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className={styles.image}
            src={`data:${shared.content.contentType};base64,${shared.content.bytes.toString(
              "base64",
            )}`}
            alt="Shared memory"
          />
        </figure>
      ) : (
        <div className={styles.unavailable} data-testid="share-unavailable">
          {shared.status === "invalid" ? (
            <span className={styles.unavailableTitle}>This share link isn&rsquo;t valid.</span>
          ) : (
            <>
              <span className={styles.unavailableTitle}>
                We couldn&rsquo;t load this right now — try again.
              </span>
              {/* A real retry: this page is force-dynamic, so a fresh request
                  re-asks the backend. No client bundle needed for one link. */}
              <a className={styles.retry} href={`/share/${encodeURIComponent(token)}`}>
                Try again
              </a>
            </>
          )}
        </div>
      )}
    </main>
  );
}
