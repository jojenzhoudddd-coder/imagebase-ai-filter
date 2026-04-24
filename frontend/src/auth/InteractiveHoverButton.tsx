/**
 * InteractiveHoverButton — ported from arsh342/careercompass.
 * Source: src/components/ui/interactive-hover-button.tsx
 *
 * Signature button visual: text that slides out to the right on hover,
 * replaced by a filled-background layer with text + arrow icon.
 *
 * Port notes:
 *   - Replaced Tailwind + cn() helper with plain CSS class names and
 *     an inline <style> to keep the component self-contained (no
 *     Tailwind config required).
 *   - Uses forwardRef so it still works as a submit target.
 */

import React from "react";

interface Props extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  text?: string;
  icon?: React.ReactNode;
}

const ArrowRight = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path
      d="M3 8h10M9 4l4 4-4 4"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const InteractiveHoverButton = React.forwardRef<HTMLButtonElement, Props>(
  ({ text = "Button", icon, className = "", children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={`ihb ${className}`}
        {...props}
      >
        <span className="ihb-label">{children ?? text}</span>
        <div className="ihb-overlay">
          <span>{children ?? text}</span>
          {icon ?? <ArrowRight />}
        </div>
      </button>
    );
  },
);
InteractiveHoverButton.displayName = "InteractiveHoverButton";

export { InteractiveHoverButton };
