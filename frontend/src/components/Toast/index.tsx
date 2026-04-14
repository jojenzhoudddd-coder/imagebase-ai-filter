import { createContext, useContext, useState, useCallback, useRef, ReactNode } from "react";
import "./Toast.css";

// ── Types ──

export type ToastType = "info" | "success" | "warning" | "error";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  type?: ToastType;
  duration?: number;         // ms, default 3000. 0 = manual close only
  closable?: boolean;        // show close button, default false
  action?: ToastAction;      // optional text button
}

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
  duration: number;
  closable: boolean;
  action?: ToastAction;
  leaving: boolean;
}

// ── Context ──

interface ToastContextValue {
  toast: (message: string, options?: ToastOptions) => void;
  info: (message: string, options?: Omit<ToastOptions, "type">) => void;
  success: (message: string, options?: Omit<ToastOptions, "type">) => void;
  warning: (message: string, options?: Omit<ToastOptions, "type">) => void;
  error: (message: string, options?: Omit<ToastOptions, "type">) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}

// ── Provider ──

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const removeToast = useCallback((id: number) => {
    // Start leave animation
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    // Remove after animation
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
      const timer = timersRef.current.get(id);
      if (timer) {
        clearTimeout(timer);
        timersRef.current.delete(id);
      }
    }, 200);
  }, []);

  const showToast = useCallback(
    (message: string, options: ToastOptions = {}) => {
      const id = nextId++;
      const item: ToastItem = {
        id,
        message,
        type: options.type ?? "info",
        duration: options.duration ?? 3000,
        closable: options.closable ?? false,
        action: options.action,
        leaving: false,
      };
      setToasts((prev) => [...prev, item]);

      if (item.duration > 0) {
        const timer = setTimeout(() => removeToast(id), item.duration);
        timersRef.current.set(id, timer);
      }
    },
    [removeToast],
  );

  const value: ToastContextValue = {
    toast: showToast,
    info: (msg, opts) => showToast(msg, { ...opts, type: "info" }),
    success: (msg, opts) => showToast(msg, { ...opts, type: "success" }),
    warning: (msg, opts) => showToast(msg, { ...opts, type: "warning" }),
    error: (msg, opts) => showToast(msg, { ...opts, type: "error" }),
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* Toast container: fixed at top center, 40px from top */}
      <div className="toast-container">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.type} ${t.leaving ? "toast-leave" : "toast-enter"}`}>
            <span className="toast-icon">
              <ToastIcon type={t.type} />
            </span>
            <span className="toast-message">{t.message}</span>
            {t.action && (
              <button className="toast-action" onClick={t.action.onClick}>
                {t.action.label}
              </button>
            )}
            {t.closable && (
              <button className="toast-close" onClick={() => removeToast(t.id)}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                  <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ── Icons (Figma: filled circle with symbol) ──

function ToastIcon({ type }: { type: ToastType }) {
  switch (type) {
    case "info":
      return (
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
          <circle cx="10" cy="10" r="10" fill="#1456F0" />
          <path d="M10 9v5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="10" cy="6.5" r="1" fill="#fff" />
        </svg>
      );
    case "success":
      return (
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
          <circle cx="10" cy="10" r="10" fill="#32A645" />
          <path d="M6.5 10.5 9 13l4.5-6" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "warning":
      return (
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
          <circle cx="10" cy="10" r="10" fill="#FF811A" />
          <path d="M10 6v5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="10" cy="13.5" r="1" fill="#fff" />
        </svg>
      );
    case "error":
      return (
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
          <circle cx="10" cy="10" r="10" fill="#F54A45" />
          <path d="M7 7l6 6M13 7l-6 6" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
  }
}
