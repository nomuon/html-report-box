import type { ButtonHTMLAttributes, ReactNode } from "react";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "danger" | "ghost" | "ghost-danger";
  size?: "md" | "lg";
  loading?: boolean;
  children: ReactNode;
}

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  disabled,
  className,
  children,
  type,
  ...rest
}: ButtonProps) {
  const classes = [
    "hrb-btn",
    `hrb-btn--${variant}`,
    size === "lg" ? "hrb-btn--lg" : "",
    loading ? "hrb-btn--loading" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type={type ?? "button"}
      className={classes}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <span className="hrb-spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}
