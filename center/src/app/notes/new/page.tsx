"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Shell } from "@/components/Shell";
import { SessionExpiredClause, StatusMessage } from "@/components/Status";
import { UnsavedChangesGuard } from "@/components/UnsavedChangesGuard";
import buttons from "@/components/buttons.module.css";
import shell from "@/components/shell.module.css";
import styles from "@/components/views.module.css";
import { BackIcon } from "@/icons";
import notes from "../notes.module.css";

/**
 * /notes/new, create a note.
 * Posts to /api/capture/note/create, which mirrors the original's
 * POST /capture/note/create { text, title } on Cosmos.
 */
export default function NewNotePage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const hasContent = Boolean(title.trim() || text.trim());

  async function save() {
    if (saving || saved || !hasContent) return;
    setSaving(true);
    setProblem(null);
    setNeedsSignIn(false);
    try {
      const res = await fetch("/api/capture/note/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim() ? title : null, text: text || "New note." }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        reauthenticate?: boolean;
        tooLong?: boolean;
      };
      if (!res.ok || !body.ok) {
        setNeedsSignIn(res.status === 401 || body.reauthenticate === true);
        setProblem(
          (res.status === 401 || body.reauthenticate)
            ? "Nothing was saved. Your draft is still here."
            : body.tooLong
              ? "This note is too long to save. Shorten it, then save again."
              : "Nothing was saved. Your draft is still here. Try again.",
        );
        return;
      }
      setSaved(true);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["notes"] }),
        queryClient.invalidateQueries({ queryKey: ["memories-dashboard"] }),
      ]);
      router.push("/notes");
    } catch {
      setProblem("Nothing was saved. Your draft is still here. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Shell
      showNav={false}
      showTopBar={false}
    >
      <UnsavedChangesGuard when={hasContent && !saved} message="Leave without saving this note?" />
      <div className={styles.detailHeader}>
        <div data-testid="top-toolbar-left">
          <div data-testid="top-back-button">
            <Link href="/notes" aria-label="Back to Notes">
              <span className={buttons.circularButton}>
                <BackIcon size={20} />
              </span>
            </Link>
          </div>
        </div>
        <div />
        <div className={shell.right} data-testid="top-toolbar-right">
          <button
            className={`${buttons.circularButton} ${buttons.circularButtonAccent}`}
            type="button"
            aria-label="Save note"
            title="Save"
            onClick={save}
            disabled={saving || saved || !hasContent}
          >
            <svg viewBox="0 0 24 24" width={20} height={20} fill="none" aria-hidden>
              <path
                d="M5 12.5L10 17.5L19 7"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>

      <div className={styles.pageContainer}>
        <h1 className={styles.srOnly}>New note</h1>
        {/* Same place and tone as the note editor's own notices. */}
        {saving ? <StatusMessage>Saving note…</StatusMessage> : null}
        {problem ? (
          <div className={notes.notice}>
            <StatusMessage tone="warning">
              {problem}
              {needsSignIn ? (
                <SessionExpiredClause
                  onReconnected={() => {
                    setProblem(null);
                    setNeedsSignIn(false);
                  }}
                />
              ) : null}
            </StatusMessage>
          </div>
        ) : null}
        <div className={styles.notePage} aria-busy={saving}>
          <input
            className={styles.noteInput}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title"
            aria-label="Note title"
            readOnly={saving || saved}
          />
          <textarea
            className={styles.noteTextarea}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="New note."
            aria-label="Note text"
            readOnly={saving || saved}
          />
        </div>
      </div>
    </Shell>
  );
}
