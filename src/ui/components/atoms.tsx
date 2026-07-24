// Shared UI atoms built on the project stylesheet (global.css).

import { useEffect, useRef, useState, type ReactNode } from "react";
import { levelFor } from "@/domain/confidence";
import { create } from "zustand";

// ---------- Switch ----------

export function Switch(props: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
  description?: string;
}) {
  return (
    <div className="switch-row">
      <div>
        <div className="switch-label">{props.label}</div>
        {props.description && <div className="switch-desc">{props.description}</div>}
      </div>
      <button
        type="button"
        role="switch"
        className="switch"
        aria-checked={props.checked}
        aria-label={props.label}
        disabled={props.disabled}
        onClick={() => props.onChange(!props.checked)}
      />
    </div>
  );
}

// ---------- Badges ----------

export function Badge(props: { tone?: "ok" | "warn" | "danger" | "neutral" | "accent"; children: ReactNode }) {
  return <span className={`badge ${props.tone ?? "neutral"}`}>{props.children}</span>;
}

export function ConfidenceBadge(props: { value: number; reasons?: string[] }) {
  const level = levelFor(props.value);
  const tone = level === "high" ? "ok" : level === "medium" ? "warn" : "danger";
  const label = level === "high" ? "可信度高" : level === "medium" ? "可信度中" : "可信度低";
  return (
    <Badge tone={tone}>
      {label} {Math.round(props.value * 100)}%
    </Badge>
  );
}

/** Confidence reasons list — always shown next to low/medium confidence values (spec §12). */
export function ConfidenceReasons(props: { reasons: string[] }) {
  if (props.reasons.length === 0) return null;
  return (
    <ul className="warn-list" aria-label="可信度原因">
      {props.reasons.map((r) => (
        <li key={r}>{r}</li>
      ))}
    </ul>
  );
}

// ---------- Empty state ----------

export function EmptyState(props: {
  icon?: string;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty" role="status">
      <div className="empty-icon" aria-hidden>
        {props.icon ?? "◎"}
      </div>
      <h2>{props.title}</h2>
      <p>{props.body}</p>
      {props.action}
    </div>
  );
}

// ---------- Modal + confirm ----------

export function Modal(props: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const focusable = dialog?.querySelector<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
    );
    (focusable ?? dialog)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
      if (e.key !== "Tab" || !dialogRef.current) return;
      const items = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
      ));
      if (!items.length) {
        e.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      returnFocusRef.current?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        tabIndex={-1}
        style={props.wide ? { width: "min(640px, calc(100vw - 40px))" } : undefined}
      >
        <div className="modal-title">
          <div>
            <h2>{props.title}</h2>
            {props.subtitle && <p>{props.subtitle}</p>}
          </div>
          <button type="button" aria-label="關閉" onClick={props.onClose}>
            ×
          </button>
        </div>
        {props.children}
      </div>
    </div>
  );
}

export function ConfirmDialog(props: {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal title={props.title} onClose={props.onCancel}>
      <p className="muted" style={{ fontSize: 13, marginBottom: 4 }}>
        {props.body}
      </p>
      <div className="modal-actions">
        <span />
        <button type="button" onClick={props.onCancel}>
          取消
        </button>
        <button
          type="button"
          className={props.danger ? "btn danger-btn" : "primary"}
          onClick={props.onConfirm}
        >
          {props.confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

// ---------- Toasts ----------

type Toast = { id: number; text: string; tone: "info" | "success" | "error" };

const useToastStore = create<{
  toasts: Toast[];
  push: (text: string, tone?: Toast["tone"]) => void;
  remove: (id: number) => void;
}>((set) => ({
  toasts: [],
  push: (text, tone = "info") =>
    set((state) => {
      const id = Date.now() + Math.random();
      setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
      }, 4200);
      return { toasts: [...state.toasts, { id, text, tone }] };
    }),
  remove: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const toast = {
  info: (text: string) => useToastStore.getState().push(text, "info"),
  success: (text: string) => useToastStore.getState().push(text, "success"),
  error: (text: string) => useToastStore.getState().push(text, "error"),
};

export function ToastRegion() {
  const toasts = useToastStore((s) => s.toasts);
  const remove = useToastStore((s) => s.remove);
  return (
    <div className="toast-region" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast ${t.tone === "error" ? "error" : t.tone === "success" ? "success" : ""}`}
          onClick={() => remove(t.id)}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}

// ---------- Percent meter (uses the stylesheet's .meter) ----------

export function Meter(props: { value: number; tone?: "ok" | "warn" | "danger" }) {
  const color =
    props.tone === "danger" ? "#b64c47" : props.tone === "warn" ? "#cf9f4d" : "#286f66";
  return (
    <div className="meter" role="progressbar" aria-valuenow={Math.round(props.value)} aria-valuemin={0} aria-valuemax={100}>
      <i style={{ width: `${Math.min(100, Math.max(0, props.value))}%`, background: color }} />
    </div>
  );
}

// ---------- Hook: ticking clock for countdowns ----------

export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
