"use client";

// Small shared UI primitives for the mobile-first interface.

import { useEffect, useRef, useState } from "react";
import { ChevronDown, CircleHelp, X } from "lucide-react";
import { GLOSSARY, type Term } from "@/lib/glossary";

/**
 * Bottom sheet on phones (drag the handle down to close), side panel on large screens.
 */
export function Sheet({
  title,
  subtitle,
  onClose,
  children,
  footer,
  side = false,
  label,
}: {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** On desktop, dock to the right instead of centring. */
  side?: boolean;
  label: string;
}) {
  const [drag, setDrag] = useState(0);
  const [dragging, setDragging] = useState(false);
  const start = useRef<number | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div
      className={`fixed inset-0 z-50 flex items-end justify-center ${side ? "md:items-stretch md:justify-end" : "md:items-center"}`}
      role="dialog"
      aria-modal
      aria-label={label}
    >
      <button className="sheet-backdrop absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={onClose} aria-label="Close" />
      <div
        className={`sheet-panel relative flex max-h-[94dvh] w-full flex-col overflow-hidden rounded-t-[28px] border border-line bg-bg shadow-2xl ${
          side ? "md:max-h-none md:max-w-[480px] md:rounded-none md:border-y-0 md:border-r-0" : "md:max-w-lg md:rounded-3xl"
        }`}
        style={{ transform: drag ? `translateY(${drag}px)` : undefined, transition: dragging ? "none" : "transform 200ms ease" }}
      >
        {/* Drag handle (phones) */}
        <div
          className="flex shrink-0 justify-center pt-2.5 pb-1 md:hidden"
          onTouchStart={(e) => {
            start.current = e.touches[0]!.clientY;
            setDragging(true);
          }}
          onTouchMove={(e) => {
            if (start.current !== null) setDrag(Math.max(0, e.touches[0]!.clientY - start.current));
          }}
          onTouchEnd={() => {
            start.current = null;
            setDragging(false);
            if (drag > 110) onClose();
            else setDrag(0);
          }}
        >
          <span className="h-1.5 w-10 rounded-full bg-line" />
        </div>
        {(title || subtitle) && (
          <div className="flex shrink-0 items-start gap-3 px-5 pt-2 pb-3 md:pt-5">
            <div className="min-w-0 flex-1">
              {title && <div className="text-lg font-semibold leading-tight">{title}</div>}
              {subtitle && <div className="mt-0.5 text-sm text-muted">{subtitle}</div>}
            </div>
            <IconButton label="Close" onClick={onClose}>
              <X size={18} />
            </IconButton>
          </div>
        )}
        <div className="flex-1 overflow-y-auto overscroll-contain px-5 pb-6">{children}</div>
        {footer && <div className="shrink-0 border-t border-line bg-bg px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">{footer}</div>}
      </div>
    </div>
  );
}

export function IconButton({
  label,
  onClick,
  children,
  active = false,
  className = "",
}: {
  label: string;
  onClick?: () => void;
  children: React.ReactNode;
  active?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`relative inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border transition active:scale-95 ${
        active ? "border-accent/50 bg-accent-bg text-accent" : "border-line bg-panel text-muted hover:text-text"
      } ${className}`}
    >
      {children}
    </button>
  );
}

/** Small "?" that opens a plain-language explanation of a term. */
export function Explain({ term, className = "" }: { term: Term; className?: string }) {
  const [open, setOpen] = useState(false);
  const g = GLOSSARY[term];
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        className={`inline-flex items-center text-muted hover:text-text ${className}`}
        aria-label={`What is ${g.title}?`}
      >
        <CircleHelp size={14} />
      </button>
      {open && (
        <Sheet label={g.title} title={g.title} onClose={() => setOpen(false)}>
          <div className="space-y-3 text-[15px] leading-relaxed text-text/90">
            {g.body.map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>
        </Sheet>
      )}
    </>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { id: T; label: React.ReactNode }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="flex rounded-2xl border border-line bg-panel p-1" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          role="tab"
          aria-selected={value === o.id}
          onClick={() => onChange(o.id)}
          className={`flex-1 rounded-xl px-3 py-2 text-sm font-medium transition ${
            value === o.id ? "bg-panel-2 text-text shadow-sm" : "text-muted"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`shrink-0 rounded-full border px-3.5 py-2 text-sm transition active:scale-[0.97] ${
        active ? "border-accent/60 bg-accent-bg font-medium text-accent" : "border-line bg-panel text-muted"
      }`}
    >
      {children}
    </button>
  );
}

/** Collapsible section for detail screens. */
export function Disclosure({
  title,
  icon,
  defaultOpen = false,
  children,
  aside,
}: {
  title: string;
  icon?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
  aside?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rounded-2xl border border-line bg-panel">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-left"
        aria-expanded={open}
      >
        {icon && <span className="text-muted">{icon}</span>}
        <span className="flex-1 text-[15px] font-medium">{title}</span>
        {aside && <span className="num text-sm text-muted">{aside}</span>}
        <ChevronDown size={18} className={`text-muted transition ${open ? "rotate-180" : ""}`} />
      </button>
      {open && <div className="border-t border-line px-4 py-3">{children}</div>}
    </section>
  );
}

/** 0–100 score as five dots with a word, so it reads without colour. */
export function QualityMeter({ score }: { score: number | null }) {
  if (score === null) return <span className="text-xs text-muted">Quality —</span>;
  const filled = Math.max(0, Math.min(5, Math.round(score / 20)));
  const word = score >= 80 ? "Excellent" : score >= 65 ? "Good" : score >= 50 ? "Fair" : "Weak";
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted" aria-label={`Quality ${Math.round(score)} of 100, ${word}`}>
      <span className="flex gap-0.5" aria-hidden>
        {Array.from({ length: 5 }, (_, i) => (
          <span key={i} className={`h-1.5 w-3 rounded-full ${i < filled ? "bg-accent" : "bg-line"}`} />
        ))}
      </span>
      {word}
    </span>
  );
}
