import { useState, useRef, useCallback, useEffect } from "react";

interface UseSpeechRecognitionOptions {
  lang?: string;
  onResult?: (text: string) => void;
  onEnd?: () => void;
}

interface UseSpeechRecognitionReturn {
  /** Whether the browser supports SpeechRecognition */
  isSupported: boolean;
  /** Whether currently listening */
  isListening: boolean;
  /** Whether in the grace period after stop (still capturing late results) */
  isStopping: boolean;
  /** Start speech recognition */
  start: () => void;
  /** Stop speech recognition (with grace delay for late results) */
  stop: () => void;
}

const SpeechRecognitionCtor: (new () => any) | undefined =
  typeof window !== "undefined"
    ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    : undefined;

/**
 * Grace period (ms) after user requests stop.
 * During this window the recognition keeps running so late-arriving
 * results from the speech engine are not lost.
 */
const STOP_GRACE_MS = 800;

export function useSpeechRecognition(
  options: UseSpeechRecognitionOptions = {},
): UseSpeechRecognitionReturn {
  const { lang = "zh-CN", onResult, onEnd } = options;

  const isSupported = !!SpeechRecognitionCtor;
  const [isListening, setIsListening] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const recognitionRef = useRef<any>(null);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callbacksRef = useRef({ onResult, onEnd });

  // Keep callbacks fresh without re-creating recognition
  useEffect(() => {
    callbacksRef.current = { onResult, onEnd };
  }, [onResult, onEnd]);

  /** Actually tear down the recognition instance */
  const doStop = useCallback(() => {
    if (stopTimerRef.current) {
      clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    setIsStopping(false);
    setIsListening(false);
  }, []);

  const start = useCallback(() => {
    if (!SpeechRecognitionCtor || recognitionRef.current) return;

    // Cancel any pending grace-period stop
    if (stopTimerRef.current) {
      clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
      setIsStopping(false);
    }

    const recognition = new SpeechRecognitionCtor();
    recognition.lang = lang;
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event: any) => {
      let text = "";
      for (let i = 0; i < event.results.length; i++) {
        text += event.results[i][0].transcript;
      }
      callbacksRef.current.onResult?.(text);
    };

    recognition.onerror = (event: any) => {
      // "aborted" is expected when we call stop()
      if (event.error !== "aborted") {
        console.warn("SpeechRecognition error:", event.error);
      }
      recognitionRef.current = null;
      setIsStopping(false);
      setIsListening(false);
      callbacksRef.current.onEnd?.();
    };

    recognition.onend = () => {
      recognitionRef.current = null;
      setIsStopping(false);
      setIsListening(false);
      callbacksRef.current.onEnd?.();
    };

    recognitionRef.current = recognition;
    recognition.start();
    setIsListening(true);
  }, [lang]);

  /**
   * Request stop with a grace period.
   * The recognition keeps running for STOP_GRACE_MS so that any
   * final results still in the pipeline are captured before shutdown.
   */
  const stop = useCallback(() => {
    if (!recognitionRef.current) return;
    // Enter "stopping" visual state (pulse → winding down)
    setIsStopping(true);
    // After grace period, actually stop
    stopTimerRef.current = setTimeout(() => {
      doStop();
      callbacksRef.current.onEnd?.();
    }, STOP_GRACE_MS);
  }, [doStop]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (stopTimerRef.current) {
        clearTimeout(stopTimerRef.current);
        stopTimerRef.current = null;
      }
      if (recognitionRef.current) {
        recognitionRef.current.stop();
        recognitionRef.current = null;
      }
    };
  }, []);

  return { isSupported, isListening, isStopping, start, stop };
}
