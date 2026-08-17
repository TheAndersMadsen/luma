"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

/*
 * "You have unsaved Pin credentials in this form."
 *
 * Ported from the retired Setup SPA's `components/UnsavedChangesPrompt.tsx` +
 * `hooks/useBeforeUnload.ts`, and extended for the App Router: the SPA only had
 * to guard `beforeunload` and a react-router blocker, whereas here a wearer can
 * also click a settings nav link, which is a client-side navigation the browser
 * never sees.
 *
 * Two guards, because they catch different things:
 *
 *   beforeunload  — tab close, reload, and any navigation that leaves the SPA.
 *                   The browser renders its own dialog; the returned string is
 *                   ignored by every current browser but is still required.
 *   click capture — an in-app <a>/<Link> to a different pathname. Intercepted
 *                   in the CAPTURE phase so Next's own click handler never
 *                   runs, then re-issued through the router only if the wearer
 *                   confirms. A capture-phase listener is the only place this
 *                   can be done without patching next/link.
 *
 * Deliberately NOT guarded: the browser Back button. `history.pushState`
 * trapping is the standard trick and it is worse than the problem — it can
 * strand a wearer on a page they cannot leave.
 */

const MESSAGE =
  "You have unsaved changes to this Pin's settings. Leave without saving?";

export function UnsavedChangesGuard({ when }: { when: boolean }) {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!when) return;

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Legacy browsers keyed off the return value; modern ones only need
      // preventDefault. Setting both is what makes the prompt reliable.
      event.returnValue = MESSAGE;
      return MESSAGE;
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [when]);

  useEffect(() => {
    if (!when) return;

    const onClick = (event: MouseEvent) => {
      // Let the browser own modified clicks: a new tab does not lose this form.
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }

      const anchor = (event.target as Element | null)?.closest?.("a");
      if (!anchor) return;

      const href = anchor.getAttribute("href");
      if (!href || anchor.target === "_blank" || anchor.hasAttribute("download")) {
        return;
      }

      let destination: URL;
      try {
        destination = new URL(href, window.location.href);
      } catch {
        return;
      }
      if (destination.origin !== window.location.origin) return;
      if (destination.pathname === pathname) return;

      event.preventDefault();
      event.stopPropagation();
      if (window.confirm(MESSAGE)) {
        router.push(`${destination.pathname}${destination.search}${destination.hash}`);
      }
    };

    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [when, pathname, router]);

  return null;
}
