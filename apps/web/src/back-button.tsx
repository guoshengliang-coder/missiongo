import type { ButtonHTMLAttributes } from "react";
import { ArrowLeft } from "lucide-react";

/** One page-navigation affordance with a stable touch target and accessible name. */
export function BackButton({ label, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button {...props} type="button" className={`icon-button back-button ${className}`} aria-label={label} title={label}><ArrowLeft size={20} aria-hidden="true" /></button>;
}
