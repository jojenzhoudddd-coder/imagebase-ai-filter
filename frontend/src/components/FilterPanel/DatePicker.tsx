import { useState, useRef, useEffect } from "react";
import "./DatePicker.css";

interface Props {
  value: string; // "YYYY/MM/DD"
  onChange: (value: string) => void;
  className?: string;
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}/${m}/${day}`;
}

function parseDate(s: string): Date {
  const [y, m, d] = s.split("/").map(Number);
  return new Date(y, m - 1, d);
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

export default function DatePicker({ value, onChange, className }: Props) {
  const hasValue = value !== "";
  const date = hasValue ? parseDate(value) : new Date();
  const [viewYear, setViewYear] = useState(date.getFullYear());
  const [viewMonth, setViewMonth] = useState(date.getMonth());
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleToggle = () => {
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 4, left: rect.left });
      const d = hasValue ? parseDate(value) : new Date();
      setViewYear(d.getFullYear());
      setViewMonth(d.getMonth());
    }
    setOpen(!open);
  };

  const handleSelect = (day: number) => {
    onChange(formatDate(new Date(viewYear, viewMonth, day)));
    setOpen(false);
  };

  const prevMonth = () => {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(viewYear - 1); }
    else setViewMonth(viewMonth - 1);
  };

  const nextMonth = () => {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(viewYear + 1); }
    else setViewMonth(viewMonth + 1);
  };

  // Build calendar grid
  const firstDay = new Date(viewYear, viewMonth, 1).getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const weeks: (number | null)[][] = [];
  let week: (number | null)[] = Array(firstDay).fill(null);
  for (let d = 1; d <= daysInMonth; d++) {
    week.push(d);
    if (week.length === 7) { weeks.push(week); week = []; }
  }
  if (week.length > 0) {
    while (week.length < 7) week.push(null);
    weeks.push(week);
  }

  const selectedDay = hasValue && date.getFullYear() === viewYear && date.getMonth() === viewMonth ? date.getDate() : -1;
  const now = new Date();
  const todayDay = now.getFullYear() === viewYear && now.getMonth() === viewMonth ? now.getDate() : -1;

  return (
    <div className={`dp-dropdown ${className ?? ""}`} ref={ref}>
      <button ref={triggerRef} type="button" className="dp-trigger" onClick={handleToggle}>
        <span className={`dp-label${hasValue ? "" : " dp-placeholder"}`}>{hasValue ? value : "Select date"}</span>
        <svg className="dp-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none">
          <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
      {open && pos && (
        <div className="dp-calendar" style={{ position: "fixed", top: pos.top, left: pos.left }}>
          <div className="dp-header">
            <button type="button" className="dp-nav" onClick={prevMonth}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <span className="dp-month-year">{MONTH_NAMES[viewMonth]} {viewYear}</span>
            <button type="button" className="dp-nav" onClick={nextMonth}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
          <div className="dp-weekdays">
            {WEEKDAYS.map((d) => <span key={d} className="dp-weekday">{d}</span>)}
          </div>
          <div className="dp-days">
            {weeks.map((w, wi) => (
              <div key={wi} className="dp-week">
                {w.map((d, di) => (
                  <button
                    key={di}
                    type="button"
                    className={`dp-day${d === null ? " empty" : ""}${d === selectedDay ? " selected" : ""}${d === todayDay && d !== selectedDay ? " today" : ""}`}
                    disabled={d === null}
                    onClick={() => d && handleSelect(d)}
                  >
                    {d ?? ""}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
