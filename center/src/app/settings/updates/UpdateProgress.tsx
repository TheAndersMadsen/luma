"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Ask the overview every ten seconds and refresh the page once a requested
 * update has finished: the Last update section then says what happened. The
 * pane mounts this only while a request is pending. A failed poll keeps the
 * page as it is; the operator can reload.
 */
export function UpdateProgress() {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        const response = await fetch("/api/admin/updates", { cache: "no-store" });
        if (response.ok && !(await response.json()).request.pending) router.refresh();
      } catch {
        // The page keeps its last state; the next poll tries again.
      }
    }, 10_000);
    return () => clearInterval(timer);
  }, [router]);
  return null;
}
