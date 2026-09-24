"use client";

import { FormEvent, useState, type ReactNode } from "react";
import { BrandMark, Icon } from "@/components/Icon";

/**
 * Shared shell for sign-in / sign-up. Keeps the security framing consistent and
 * avoids duplicating the same card chrome across both routes.
 */
export function AuthShell({
  eyebrow,
  title,
  subtitle,
  children,
  footer,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="setup-page">
      <div className="setup-card">
        <div className="setup-brand">
          <BrandMark size={30} withWordmark={false} />
        </div>
        <p className="setup-eyebrow">{eyebrow}</p>
        <h1 className="setup-title">{title}</h1>
        <p className="setup-sub">{subtitle}</p>
        {children}
        {footer && <div className="setup-footer">{footer}</div>}
      </div>
    </main>
  );
}

/** Labelled field with an optional trailing control (e.g. show/hide password). */
export function Field({
  id,
  label,
  type = "text",
  value,
  onChange,
  placeholder,
  autoComplete,
  required,
  hint,
  trailing,
  invalid,
}: {
  id: string;
  label: string;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoComplete?: string;
  required?: boolean;
  hint?: string;
  trailing?: ReactNode;
  invalid?: boolean;
}) {
  return (
    <div className="setup-field">
      <label className="setup-field-label" htmlFor={id}>
        {label}
      </label>
      <div className="field-control">
        <input
          id={id}
          type={type}
          className="setup-input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          required={required}
          aria-invalid={invalid || undefined}
          aria-describedby={hint ? `${id}-hint` : undefined}
        />
        {trailing}
      </div>
      {hint && (
        <p className="setup-hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
    </div>
  );
}

/** Show/hide password toggle used by the auth forms. */
export function PasswordVisibilityToggle({
  visible,
  onToggle,
  inputId,
}: {
  visible: boolean;
  onToggle: () => void;
  inputId: string;
}) {
  return (
    <button
      type="button"
      className="field-trailing"
      onClick={onToggle}
      aria-label={visible ? "Hide password" : "Show password"}
      aria-controls={inputId}
      title={visible ? "Hide password" : "Show password"}
    >
      <Icon name={visible ? "eyeOff" : "eye"} size={18} />
    </button>
  );
}

export function AuthError({ message }: { message: string }) {
  if (!message) return null;
  return (
    <p className="setup-error" role="alert">
      <Icon name="info" size={14} />
      {message}
    </p>
  );
}
