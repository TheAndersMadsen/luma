"use client";

import Link from "next/link";
import { usePasscodeState } from "@/lib/queries";

/**
 * Whether the signed-in owner set the passcode their Pin asks for during
 * setup. It is theirs alone. Cosmos keeps no copy it could show here.
 */
export function PasscodeFact() {
  const { data, isLoading } = usePasscodeState();
  if (isLoading) {
    return <span>Checking&hellip;</span>;
  }
  if (data?.set === true) {
    return (
      <span>
        Set · <Link href="/settings/account/security">Change</Link>
      </span>
    );
  }
  if (data?.set === false) {
    return (
      <span>
        Not set · <Link href="/settings/account/security">Set it before setting up your Pin</Link>
      </span>
    );
  }
  return <span>Couldn&rsquo;t be checked</span>;
}
