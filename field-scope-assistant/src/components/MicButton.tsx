"use client";
import { useEffect, useRef, useState } from "react";

type Rec = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
};

/**
 * Browser speech-to-text (Web Speech API). Final phrases are appended to the
 * target field. Where unsupported, the phone keyboard's own mic still works.
 */
export default function MicButton({ onText, label = "Dictate" }: { onText: (t: string) => void; label?: string }) {
  const [supported, setSupported] = useState(false);
  const [live, setLive] = useState(false);
  const recRef = useRef<Rec | null>(null);
  const cb = useRef(onText);
  cb.current = onText;

  useEffect(() => {
    const w = window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec };
    setSupported(!!(w.SpeechRecognition || w.webkitSpeechRecognition));
    return () => recRef.current?.stop();
  }, []);

  if (!supported) return null;

  const toggle = () => {
    if (live) {
      recRef.current?.stop();
      return;
    }
    const w = window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec };
    const Ctor = (w.SpeechRecognition || w.webkitSpeechRecognition)!;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = "en-US";
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) cb.current(e.results[i][0].transcript.trim());
    };
    rec.onend = () => setLive(false);
    rec.onerror = () => setLive(false);
    recRef.current = rec;
    rec.start();
    setLive(true);
  };

  return (
    <button type="button" className={`btn mic ${live ? "live" : ""}`} onClick={toggle} aria-pressed={live} title="Voice dictation">
      {live ? "■ Stop" : `🎙 ${label}`}
    </button>
  );
}
