import type { ButtonHTMLAttributes, ReactNode } from "react";

const BUTTON_BASE =
  "inline-flex items-center justify-center rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";

const BUTTON_VARIANTS = {
  primary: "bg-blue-600 text-white hover:bg-blue-700",
  secondary: "border border-gray-300 bg-white text-gray-800 hover:bg-gray-50",
  danger: "border border-red-300 bg-white text-red-700 hover:bg-red-50",
  ghost: "text-gray-600 hover:bg-gray-100",
};

export function buttonClass(variant: keyof typeof BUTTON_VARIANTS = "primary"): string {
  return `${BUTTON_BASE} ${BUTTON_VARIANTS[variant]}`;
}

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof BUTTON_VARIANTS }) {
  return <button type="button" {...props} className={`${buttonClass(variant)} ${className}`} />;
}

export const inputClass =
  "block w-full rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-100";

/** The same field without stretching to the full width, for inputs that carry their own width. */
export const inputInlineClass = inputClass.replace("block w-full ", "block ");

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-lg border border-gray-200 bg-white ${className}`}>{children}</div>;
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-xl font-semibold">{title}</h1>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

const BADGE_TONES = {
  gray: "bg-gray-100 text-gray-700",
  green: "bg-green-100 text-green-800",
  amber: "bg-amber-100 text-amber-800",
  red: "bg-red-100 text-red-800",
  blue: "bg-blue-100 text-blue-800",
};

export function Badge({ tone = "gray", children }: { tone?: keyof typeof BADGE_TONES; children: ReactNode }) {
  return (
    <span className={`inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium ${BADGE_TONES[tone]}`}>
      {children}
    </span>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" data-form-error data-testid="form-error" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
      {children}
    </p>
  );
}

export const tableClass = "w-full border-collapse text-left text-sm";
export const thClass = "border-b border-gray-200 bg-gray-50 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-gray-500";
export const tdClass = "border-b border-gray-100 px-3 py-2 align-top";

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="px-3 py-8 text-center text-gray-500">{children}</p>;
}
