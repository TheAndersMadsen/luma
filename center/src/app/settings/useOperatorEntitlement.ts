"use client";

import { useQuery } from "@tanstack/react-query";

/** Whether this signed-in session may see operator-only settings. */
export function useOperatorEntitlement(): boolean {
  const { data } = useQuery({
    queryKey: ["session-entitlement"],
    queryFn: async (): Promise<boolean> => {
      const response = await fetch("/api/auth/session", { cache: "no-store" }).catch(() => null);
      if (!response?.ok) return false;
      const body = (await response.json().catch(() => null)) as { operator?: unknown } | null;
      return body?.operator === true;
    },
    retry: false,
    staleTime: 60_000,
  });

  return data === true;
}
