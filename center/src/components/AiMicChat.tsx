"use client";

import { useQuery } from "@tanstack/react-query";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import styles from "@/app/talk/talk.module.css";
import { StatusChip } from "./Status";

/**
 * The Ai Mic conversation — the assistant loop, reusable.
 *
 * Extracted from the /talk page so the same chat drives both the full page and
 * the floating modal the Ai Mic button opens. Renders the transcript and the
 * composer; the surrounding chrome (page header, modal frame) is the caller's.
 * Speech OUT is TTS from the backend; speech IN uses the browser's
 * SpeechRecognition when available (long-press to talk), degrading to plain
 * typing when it is not.
 */

type StepKind = "action" | "observation" | "answer";
type TraceStep = { kind: StepKind; name: string; source: "device" | "server"; text: string; input: string; elapsed_ms: number };
type Turn = { id: string; role: "you" | "pin"; text: string; cue?: string; steps: TraceStep[]; streaming: boolean };

/** What this deployment reports about the assistant behind the mic. */
export type AssistantStatus = { assistant: boolean; speech: boolean; model: string };

/**
 * The assistant's readiness. Shared query key, so the chat, the floating
 * panel's header and the /talk page all read ONE fetch — and all say the same
 * thing about it.
 */
export function useAssistantStatus() {
  return useQuery({
    queryKey: ["assistant-status"],
    queryFn: async (): Promise<AssistantStatus> => {
      const res = await fetch("/api/assistant/status", { cache: "no-store" }).catch(() => null);
      const body = res ? ((await res.json().catch(() => null)) as Partial<AssistantStatus> | null) : null;
      if (!body) return { assistant: false, speech: false, model: "unreachable" };
      return {
        assistant: Boolean(body.assistant),
        speech: Boolean(body.speech),
        model: typeof body.model === "string" ? body.model : "unknown",
      };
    },
    retry: false,
    staleTime: 30_000,
  });
}

/**
 * That same readiness, said out loud.
 *
 * This component already fetched it and spent it on a `title` attribute — so a
 * mic that could not possibly answer looked exactly like one that could. Three
 * different situations, three different sentences: it works, it isn't
 * answering, this deployment has no model at all.
 */
export function AssistantStatusChip({ className }: { className?: string }) {
  const { data } = useAssistantStatus();
  if (!data) return null;

  if (data.assistant) {
    return (
      <StatusChip
        tone="live"
        label="Assistant ready"
        detail={data.speech ? "Spoken replies are on." : "Text replies are available."}
        className={className}
      />
    );
  }
  if (data.model === "unreachable") {
    return (
      <StatusChip
        tone="degraded"
        label="Assistant unavailable"
        detail="Try again shortly."
        className={className}
      />
    );
  }
  return (
    <StatusChip
      tone="off"
      label="Set up Assistant"
      detail="Choose an assistant service in Settings."
      className={className}
    />
  );
}

export function AiMicChat({ autoListen = false, active = true }: { autoListen?: boolean; active?: boolean }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [voice, setVoice] = useState(true);
  const { data: status } = useAssistantStatus();
  const [listening, setListening] = useState(false);
  // Held in state, not a ref: a ref never re-renders, so the Talk button used to
  // stay hidden on first paint even where speech input is supported.
  const [speechSupported, setSpeechSupported] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  /** The object URL behind `audioRef`, so an unmount mid-playback can revoke it. */
  const audioUrlRef = useRef<string | null>(null);
  /** The in-flight assistant turn, so an unmount can stop reading it. */
  const streamAbortRef = useRef<AbortController | null>(null);
  /**
   * False once this chat has unmounted. Nothing may START speaking after that:
   * the answer arrives long after the request, so without this a reply that came
   * back one tick too late began playing over a page the wearer had moved on to.
   */
  const liveRef = useRef(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const composerInputRef = useRef<HTMLInputElement | null>(null);
  const recognitionRef = useRef<{ stop: () => void; abort: () => void } | null>(null);
  // Latest `ask`, so speech-recognition callbacks (bound once) always call the
  // current closure rather than a stale one.
  const askRef = useRef<(m: string) => void>(() => {});

  useEffect(() => {
    setSpeechSupported(
      typeof window !== "undefined" &&
        !!((window as unknown as Record<string, unknown>).SpeechRecognition ||
          (window as unknown as Record<string, unknown>).webkitSpeechRecognition),
    );
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  }, [turns]);

  /*
   * Stop talking when the wearer walks away.
   *
   * `speak()` builds a DETACHED `new Audio(src)` and plays it. A detached, playing
   * media element is not part of the React tree and is not collected while it is
   * playing, so unmounting this component did nothing to it: a wearer who asked
   * the Pin something on /talk and then tapped Memories had the Pin's voice keep
   * answering over an unrelated page, with no control anywhere on screen to stop
   * it — reloading the tab was the only remedy. The ref this reads has existed
   * all along and was written and never read.
   *
   * The same unmount left `ask()`'s SSE reader running, which is both a socket
   * nobody is reading and the thing that could START a new reply after the wearer
   * had already left. PinDeviceProvider.tsx spells out why a reader has to be
   * cancelled in a `finally`; this component is the one that did not.
   */
  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
      streamAbortRef.current?.abort();
      const audio = audioRef.current;
      if (audio) {
        audio.pause();
        audio.src = "";
        audioRef.current = null;
      }
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
        audioUrlRef.current = null;
      }
    };
  }, []);

  // Collapsing the floating assistant stops every active audio/input path while
  // keeping the transcript mounted for the next time the wearer opens it.
  useEffect(() => {
    if (active) {
      window.requestAnimationFrame(() => composerInputRef.current?.focus());
      return;
    }
    streamAbortRef.current?.abort();
    recognitionRef.current?.abort();
    setListening(false);
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.src = "";
      audioRef.current = null;
    }
  }, [active]);

  const speak = useCallback(
    async (text: string): Promise<void> => {
      if (!voice || !status?.speech || !text.trim() || !liveRef.current) return;
      const res = await fetch("/api/assistant/speech", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      }).catch(() => null);
      if (!res || !res.ok) return;
      const blob = await res.blob();
      // The wearer may have left while the speech was being synthesised. Starting
      // playback now would talk over whatever page they are on instead.
      if (!liveRef.current) return;
      const src = URL.createObjectURL(blob);
      const audio = new Audio(src);
      audioRef.current = audio;
      audioUrlRef.current = src;
      const done = () => {
        URL.revokeObjectURL(src);
        if (audioUrlRef.current === src) audioUrlRef.current = null;
      };
      await new Promise<void>((resolve) => {
        audio.onended = () => { done(); resolve(); };
        audio.onerror = () => { done(); resolve(); };
        audio.play().catch(() => { done(); resolve(); });
      });
    },
    [voice, status?.speech],
  );

  const ask = useCallback(
    async (message: string) => {
      const text = message.trim();
      if (!text || busy) return;
      setDraft("");
      setBusy(true);
      setTurns((cur) => [...cur, { id: crypto.randomUUID(), role: "you", text, steps: [], streaming: false }]);
      const turnId = crypto.randomUUID();
      setTurns((cur) => [...cur, { id: turnId, role: "pin", text: "", steps: [], streaming: true }]);
      const patch = (fn: (t: Turn) => Turn) => setTurns((cur) => cur.map((t) => (t.id === turnId ? fn(t) : t)));

      let cueSpoken: Promise<void> = Promise.resolve();
      let reply = "";
      const controller = new AbortController();
      streamAbortRef.current = controller;
      try {
        const res = await fetch("/api/assistant/stream", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error("The assistant could not answer.");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffered = "";
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffered += decoder.decode(value, { stream: true });
            const frames = buffered.split("\n\n");
            buffered = frames.pop() ?? "";
            for (const frame of frames) {
              let name = "message";
              const data: string[] = [];
              for (const line of frame.split("\n")) {
                if (line.startsWith("event:")) name = line.slice(6).trim();
                else if (line.startsWith("data:")) data.push(line.slice(5).trim());
              }
              if (!data.length) continue;
              let parsed: Record<string, unknown>;
              try { parsed = JSON.parse(data.join("\n")); } catch { continue; }
              if (name === "cue") {
                const cue = String(parsed.text ?? "");
                patch((t) => ({ ...t, cue }));
                cueSpoken = speak(cue);
              } else if (name === "step") {
                const step = parsed as unknown as TraceStep;
                if (step.kind === "answer") reply = step.text;
                patch((t) => ({ ...t, text: step.kind === "answer" ? step.text : t.text, steps: [...t.steps, step] }));
              }
            }
          }
        } finally {
          // The body is a live socket. Leaving it open on the way out is what
          // let a turn keep arriving — and keep speaking — after the wearer had
          // navigated away from the chat entirely.
          await reader.cancel().catch(() => undefined);
        }
        patch((t) => ({ ...t, streaming: false }));
        if (voice && status?.speech && reply.trim()) { await cueSpoken; await speak(reply); }
        else await cueSpoken;
      } catch (error) {
        // An abort is this component going away, not a backend failure, and a
        // dead turn must not be labelled as one.
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          const msg = error instanceof Error ? error.message : "The assistant is unavailable.";
          patch((t) => ({ ...t, streaming: false, text: t.text || msg }));
        }
      } finally {
        if (streamAbortRef.current === controller) streamAbortRef.current = null;
        setBusy(false);
      }
    },
    [busy, voice, status?.speech, speak],
  );

  useEffect(() => { askRef.current = ask; }, [ask]);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    setListening(false);
  }, []);

  const startListening = useCallback(() => {
    const SR = (window as unknown as Record<string, new () => never>).SpeechRecognition
      || (window as unknown as Record<string, new () => never>).webkitSpeechRecognition;
    if (!SR) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rec: any = new (SR as unknown as { new (): unknown })();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onresult = (e: any) => {
      let transcript = "";
      for (let i = 0; i < e.results.length; i += 1) transcript += e.results[i][0].transcript;
      setDraft(transcript);
      if (e.results[e.results.length - 1].isFinal) {
        const finalText = transcript.trim();
        rec.stop();
        if (finalText) askRef.current(finalText);
      }
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recognitionRef.current = rec;
    setListening(true);
    try { rec.start(); } catch { setListening(false); }
  }, []);

  // Long-press entry point: begin listening as soon as the modal mounts.
  useEffect(() => {
    if (autoListen && active) startListening();
    return () => recognitionRef.current?.abort?.();
  }, [active, autoListen, startListening]);

  return (
    <>
      <div className={styles.thread} ref={scrollRef}>
        {turns.length === 0 && (
          <div className={styles.empty}>
            <p>{listening ? "Listening…" : "Ask your Ai Pin"}</p>
          </div>
        )}
        {/* Only "you" turns are styled differently; there is no `.pin` class,
            and indexing for one produced className="undefined". */}
        {turns.map((t) => (
          <article key={t.id} className={`${styles.turn} ${t.role === "you" ? styles.you : ""}`}>
            <span className={styles.who}>{t.role === "you" ? "You" : "Ai Pin"}</span>
            <div className={styles.body}>
              {t.cue && <p className={styles.cue} role="status">{t.cue}</p>}
              {t.text ? <p className={styles.say}>{t.text}</p>
                : t.streaming && !t.cue ? (
                  <p className={styles.thinking} role="status">
                    <span className={styles.dots} aria-hidden><i /><i /><i /></span>
                    Working…
                  </p>
                )
                : t.steps.length > 0 ? <p className={styles.silent}>Done on your Pin. No spoken reply.</p>
                : null}
            </div>
          </article>
        ))}
      </div>

      <form
        className={styles.composer}
        onSubmit={(e: FormEvent) => { e.preventDefault(); void ask(draft); }}
      >
        <button
          type="button"
          className={`${styles.voice} ${voice ? styles.voiceOn : ""}`}
          onClick={() => setVoice((v) => !v)}
          aria-pressed={voice}
          title={status?.speech ? "Spoken replies" : "Spoken replies unavailable"}
        >
          ◖ Voice {voice ? "on" : "off"}
        </button>
        <input
          ref={composerInputRef}
          className={styles.composerInput}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={listening ? "Listening…" : "Ask your Pin…"}
          maxLength={4000}
          disabled={busy}
          aria-label="Ask your Pin"
        />
        {speechSupported ? (
          <button
            type="button"
            className={`${styles.micButton} ${listening ? styles.micButtonOn : ""}`}
            onClick={() => (listening ? stopListening() : startListening())}
            aria-label={listening ? "Stop listening" : "Talk"}
            aria-pressed={listening}
            title={listening ? "Stop" : "Talk"}
          >
            ●
          </button>
        ) : null}
        <button type="submit" className={styles.send} disabled={!draft.trim() || busy} aria-label="Send">↗</button>
      </form>
    </>
  );
}
