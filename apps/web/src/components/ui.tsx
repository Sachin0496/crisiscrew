import type { ReactNode } from "react";
import type { Tone } from "../format";

export function Badge({ tone = "neutral", dot = false, mono = false, title, children }: { tone?: Tone; dot?: boolean; mono?: boolean; title?: string; children: ReactNode }) {
  const className = ["badge", tone !== "neutral" && `badge-${tone}`, dot && "badge-dot", mono && "mono"].filter(Boolean).join(" ");
  return (
    <span className={className} title={title}>
      {children}
    </span>
  );
}

type CardProps = {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  /** Lets tables and lists run edge to edge. */
  flush?: boolean;
  className?: string;
  children: ReactNode;
};

export function Card({ title, subtitle, actions, footer, flush = false, className, children }: CardProps) {
  return (
    <section className={["card", className].filter(Boolean).join(" ")} aria-label={title}>
      <header className="card-header">
        <div className="card-heading">
          <h2 className="card-title">{title}</h2>
          {subtitle && <p className="card-subtitle">{subtitle}</p>}
        </div>
        {actions && <div className="card-actions">{actions}</div>}
      </header>
      <div className={flush ? "card-flush" : "card-body"}>{children}</div>
      {footer && <footer className="card-footer">{footer}</footer>}
    </section>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="card stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-icon" aria-hidden>
        {icon}
      </span>
      <span className="empty-title">{title}</span>
      {children && <p>{children}</p>}
    </div>
  );
}

export function Callout({ tone = "neutral", icon, children }: { tone?: Tone; icon?: ReactNode; children: ReactNode }) {
  return (
    <div className={tone === "neutral" ? "callout" : `callout callout-${tone}`} role="status">
      {icon}
      <div>{children}</div>
    </div>
  );
}

export function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (value: T) => void }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
