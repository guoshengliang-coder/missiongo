import { useEffect, useRef, type CompositionEvent, type KeyboardEvent, type TextareaHTMLAttributes } from "react";

import { composerEnterAction, isCoarsePointer } from "./composer-enter";

export function resizeTextarea(textarea: HTMLTextAreaElement, maximumHeight = 480): void {
  textarea.style.height = "auto";
  const nextHeight = Math.min(textarea.scrollHeight, maximumHeight);
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = textarea.scrollHeight > maximumHeight ? "auto" : "hidden";
}

type AutoGrowTextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  readonly maximumHeight?: number;
  /**
   * Enter submits the surrounding form instead of adding a newline, on a
   * keyboard only -- a touch screen keeps Enter as its only newline key
   * (AND-256). Off by default: the long-form report fields must keep Enter.
   */
  readonly submitOnEnter?: boolean;
};

export function AutoGrowTextarea({
  className,
  maximumHeight = 480,
  onCompositionEnd,
  onCompositionStart,
  onInput,
  onKeyDown,
  submitOnEnter = false,
  value,
  ...props
}: AutoGrowTextareaProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);

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
      onCompositionStart={(event: CompositionEvent<HTMLTextAreaElement>) => {
        composingRef.current = true;
        onCompositionStart?.(event);
      }}
      onCompositionEnd={(event: CompositionEvent<HTMLTextAreaElement>) => {
        // Safari ends the composition before the keydown that confirms it arrives,
        // and that keydown reports isComposing false. Clearing the flag on the next
        // turn instead of now is what keeps that Enter from sending the reply.
        setTimeout(() => { composingRef.current = false; }, 0);
        onCompositionEnd?.(event);
      }}
      onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
        onKeyDown?.(event);
        if (!submitOnEnter || event.defaultPrevented) return;
        const action = composerEnterAction({
          key: event.key,
          shiftKey: event.shiftKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
          composing: event.nativeEvent.isComposing || composingRef.current,
        }, String(value ?? ""), isCoarsePointer());
        if (action.preventDefault) event.preventDefault();
        if (action.submit) event.currentTarget.form?.requestSubmit();
      }}
    />
  );
}
