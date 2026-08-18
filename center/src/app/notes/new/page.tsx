"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Shell } from "@/components/Shell";
import { StatusMessage } from "@/components/Status";
import buttons from "@/components/buttons.module.css";
import styles from "@/components/views.module.css";
import { BackIcon } from "@/icons";

/**
 * /notes/new — create a note.
 * Posts to /api/capture/note/create, which mirrors the original's
 * POST /capture/note/create { text, title } and reaches cosmos's CreateNote.
 */
export default function NewNotePage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function save() {
    if (saving) return;
    setSaving(true);
    setProblem(null);
    try {
      const res = await fetch("/api/capture/note/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim() || undefined, text: text || "New note." }),
      });
      const body = (await res.json()) as { ok?: boolean; degraded?: string };
      if (!body.ok) {
        setProblem(body.degraded ?? "Couldn't save this note.");
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ["notes"] });
      router.push("/notes");
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Couldn't save this note.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Shell
      showNav={false}
      toolbarRight={
        <button
          className={buttons.circularButton}
          type="button"
          aria-label="Save note"
          disabled={saving}
          onClick={save}
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
      }
    >
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
        <div />
      </div>

      <div className={styles.pageContainer}>
        <div className={styles.notePage}>
          <input
            className={styles.noteInput}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title"
            aria-label="Note title"
          />
          <textarea
            className={styles.noteTextarea}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="New note."
            aria-label="Note text"
          />
        </div>
        {problem ? (
          /* Placement only — <StatusMessage> owns the tone, the colour and the
             role="alert" that used to be hand-rolled here in an inline object. */
          <div style={{ maxWidth: 620, margin: "14px auto 0" }}>
            <StatusMessage tone="danger">{problem}</StatusMessage>
          </div>
        ) : null}
      </div>
    </Shell>
  );
}
