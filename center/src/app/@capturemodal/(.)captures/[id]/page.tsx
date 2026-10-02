"use client";

import { use } from "react";
import { CaptureLightbox } from "../../CaptureLightbox";

/**
 * Intercepting route: /captures/[id] opened by a SOFT navigation from the grid.
 * Renders the lightbox into the @capturemodal slot, over the grid. A refresh or
 * deep link bypasses interception and hits the full page at captures/[id].
 */
export default function InterceptedCapturePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return <CaptureLightbox uuid={id} />;
}
