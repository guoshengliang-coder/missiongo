import { useEffect, useRef, type TextareaHTMLAttributes } from "react";

export function resizeTextarea(textarea: HTMLTextAreaElement, maximumHeight = 480): void {
  textarea.style.height = "auto";
  const nextHeight = Math.min(textarea.scrollHeight, maximumHeight);
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = textarea.scrollHeight > maximumHeight ? "auto" : "hidden";
}

type AutoGrowTextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  readonly maximumHeight?: number;
};

export function AutoGrowTextarea({
  className,
  maximumHeight = 480,
  onInput,
  value,
  ...props
}: AutoGrowTextareaProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textareaRef.current) resizeTextarea(textareaRef.current, maximumHeight);
  }, [maximumHeight, value]);

  return (
    <textarea
      {...props}
      ref={textareaRef}
      className={`auto-grow-textarea ${className ?? ""}`.trim()}
      value={value}
      onInput={(event) => {
        resizeTextarea(event.currentTarget, maximumHeight);
        onInput?.(event);
      }}
    />
  );
}
