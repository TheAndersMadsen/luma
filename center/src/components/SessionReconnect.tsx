"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { SignInForm } from "./SignInForm";
import styles from "./sessionReconnect.module.css";

export type SessionIdentity = { sub: string; email: string };
export const SessionIdentityContext = createContext<SessionIdentity | null>(null);

/** INFERRED Luma UX: reauthenticate in place so an unfinished edit survives. */
export function SessionReconnect({ onReconnected }: { onReconnected?: () => void } = {}) {
  const identity = useContext(SessionIdentityContext);
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const client = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (open) dialog.current?.showModal();
  }, [open]);

  function close() {
    dialog.current?.close();
    setOpen(false);
    trigger.current?.focus();
  }

  if (!identity?.email) return <Link href={`/login?next=${encodeURIComponent(pathname)}`}>Sign in</Link>;

  return <>
    <button ref={trigger} type="button" className={styles.reconnect} onClick={() => setOpen(true)}>Reconnect</button>
    {open && <dialog ref={dialog} className={styles.dialog} aria-labelledby="reconnect-title" aria-describedby="reconnect-description" onCancel={close}>
      <button type="button" className={styles.close} aria-label="Close sign in" onClick={close}>×</button>
      <h2 id="reconnect-title">Reconnect</h2>
      <p id="reconnect-description">Sign in to continue. Your page and unfinished edits will stay here.</p>
      <SignInForm email={identity.email} onSuccess={(subject) => {
        // A changed identity must drop every old query and device context.
        if (subject !== identity.sub) { window.location.reload(); return; }
        close();
        onReconnected?.();
        void client.invalidateQueries();
        router.refresh();
      }} />
    </dialog>}
  </>;
}
