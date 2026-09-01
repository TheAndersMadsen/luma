"use client";

import { useEffect, useState } from "react";

export function MusicArtwork({
  src,
  tint,
  className,
  alt,
}: {
  src: string | null;
  tint: string;
  className: string;
  alt: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);

  if (!src || failed) {
    return <span className={className} style={{ background: tint }} aria-hidden="true" />;
  }
  return (
    // Provider artwork is resolved through a same-origin, authenticated route.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={className}
      src={src}
      alt={alt}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}
