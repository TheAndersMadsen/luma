import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { HumaneLogo } from "@/icons";
import { resolveSharedCapture } from "@/server/domain/captures";
import styles from "./share.module.css";

/*
 * PUBLIC share page: `/humane.center/share/capture/{uuid}?expiry=…&signature=…`.
 *
 * The path is the stock link shape. Stock Messages recognises a share only by
 * `https://(.*)humane.center/share/capture/(.*)\?expiry=(.*)signature=(.*)`
 * (`ShareLinkUtil.SHARE_LINK_REGEX`), and an owner's own domain never contains
 * that text, so it is the first path segment here. Cosmos mints the link, for
 * the web share button and for the Pin's `GetMemoryShareLink` alike, and
 * Cosmos resolves it: this page hands the link's expiry and signature to
 * Cosmos and shows the frame it answers, with NO login.
 *
 * TWO failures, two sentences: `invalid` is a verdict on the link (forged,
 * expired, or the capture is gone) and answers 404 through `not-found.tsx`;
 * `degraded` is our end not answering, and gets a retry.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Shared memory — Luma",
  // A share link is public-by-link, not public-to-crawlers.
  robots: { index: false, follow: false },
};

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? undefined : value;
}

export default async function SharedCapturePage({
  params,
  searchParams,
}: {
  params: Promise<{ uuid: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { uuid } = await params;
  const query = await searchParams;
  const expiry = single(query.expiry);
  const signature = single(query.signature);
  const shared = await resolveSharedCapture(uuid, expiry, signature);
  if (shared.status === "invalid") notFound();
  const retry = `/humane.center/share/capture/${encodeURIComponent(uuid)}?${new URLSearchParams({
    expiry: expiry ?? "",
    signature: signature ?? "",
  })}`;

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
            src={`data:${shared.contentType};base64,${shared.bytes.toString("base64")}`}
            alt="Shared memory"
          />
        </figure>
      ) : (
        <div className={styles.unavailable} data-testid="share-unavailable">
          <span className={styles.unavailableTitle}>
            We couldn&rsquo;t load this right now — try again.
          </span>
          {/* A real retry: this page is force-dynamic, so a fresh request
              asks Cosmos again. No client bundle needed for one link. */}
          <a className={styles.retry} href={retry}>
            Try again
          </a>
        </div>
      )}
    </main>
  );
}
