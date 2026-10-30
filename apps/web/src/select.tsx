import { Children, Fragment, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type SelectHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

interface Choice { value: string; label: string; disabled: boolean; group?: string | undefined }
interface Props extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "multiple" | "size"> {
  renderValue?: (value: string) => ReactNode;
  renderOption?: (value: string) => ReactNode;
}

function textOf(node: ReactNode): string {
  return Children.toArray(node).map(child => isValidElement<{ children?: ReactNode }>(child)
    ? textOf(child.props.children) : typeof child === "string" || typeof child === "number" ? String(child) : "").join("");
}

function choicesOf(children: ReactNode, group?: string, disabled = false): Choice[] {
  return Children.toArray(children).flatMap(child => {
    if (!isValidElement<{ children?: ReactNode; value?: string | number; label?: string; disabled?: boolean }>(child)) return [];
    if (child.type === Fragment) return choicesOf(child.props.children, group, disabled);
    if (child.type === "optgroup") return choicesOf(child.props.children, child.props.label, disabled || Boolean(child.props.disabled));
    if (child.type !== "option") return [];
    const label = child.props.label ?? textOf(child.props.children);
    return [{ value: String(child.props.value ?? label), label, disabled: disabled || Boolean(child.props.disabled), group }];
  });
}

/** Select-only combobox. The hidden native control owns form data/validity;
 * users interact with the button/listbox on every platform. No UA menu is opened.
 * Portals go beside a modal's content, inside its top layer and outside scrollers.
 * This also works on the browser baseline, without the newer Popover API. */
export function Select({ children, value, defaultValue, onChange, className = "", style, id, disabled, renderValue, renderOption, ...props }: Props) {
  const generatedId = useId();
  const controlId = id ?? `select-${generatedId}`;
  const listId = `${controlId}-list`;
  const nativeRef = useRef<HTMLSelectElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const search = useRef({ text: "", at: 0 });
  const [localValue, setLocalValue] = useState(String(defaultValue ?? ""));
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [label, setLabel] = useState<string | undefined>(props["aria-label"]);
  const [error, setError] = useState("");
  const options = choicesOf(children);
  const requested = String(value ?? localValue);
  // Match native select fallback when options are replaced asynchronously.
  const selected = options.findIndex(option => option.value === requested);
  const selectedIndex = selected >= 0 ? selected : options.findIndex(option => !option.disabled);
  const current = options[selectedIndex];
  const [position, setPosition] = useState<{ left: number; top: number; width: number; maxHeight: number; side: string } | null>(null);
  const optionsKey = JSON.stringify(options);

  useLayoutEffect(() => {
    if (props["aria-label"] || props["aria-labelledby"]) { setLabel(props["aria-label"]); return; }
    const source = (triggerRef.current?.closest("label") ?? triggerRef.current?.labels?.[0])?.cloneNode(true) as HTMLElement | undefined;
    source?.querySelectorAll("button, select, .single-select-error, [aria-hidden=true], [role=tooltip]").forEach(node => node.remove());
    setLabel(source?.textContent?.replace(/\s+/g, " ").trim() || undefined);
  }, [children, props["aria-label"], props["aria-labelledby"]]);

  useEffect(() => {
    const native = nativeRef.current;
    let resetTimer: number | undefined;
    const reset = (event: Event) => { resetTimer = window.setTimeout(() => {
      if (event.defaultPrevented) return;
      if (value !== undefined && native) native.value = String(value);
      else setLocalValue(native?.value ?? "");
      setError(""); setOpen(false);
    }, 0); };
    native?.form?.addEventListener("reset", reset);
    return () => { native?.form?.removeEventListener("reset", reset); window.clearTimeout(resetTimer); };
  }, [value]);

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => { if (nativeRef.current?.validity.valid) setError(""); }, [value, optionsKey, props.required]);
  useEffect(() => { if (open) setActive(selectedIndex); }, [selectedIndex, optionsKey]);

  useLayoutEffect(() => {
    if (!open) { setPosition(null); return; }
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    const fit = () => {
      if (trigger.matches(":disabled")) { setOpen(false); return; }
      const anchor = trigger.getBoundingClientRect();
      const viewport = window.visualViewport;
      const x = viewport?.offsetLeft ?? 0, y = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth, height = viewport?.height ?? window.innerHeight;
      if (anchor.bottom < y || anchor.top > y + height || anchor.right < x || anchor.left > x + width) { setOpen(false); return; }
      const below = Math.max(0, y + height - anchor.bottom - 14);
      const above = Math.max(0, anchor.top - y - 14);
      const desiredHeight = Math.min(320, menu.scrollHeight);
      const upward = below < desiredHeight && above > below;
      const maxHeight = Math.min(320, upward ? above : below);
      const menuWidth = Math.min(Math.max(anchor.width, 200), Math.max(0, width - 16));
      setPosition({
        left: Math.min(Math.max(x + 8, anchor.left), x + width - menuWidth - 8),
        top: upward ? Math.max(y + 8, anchor.top - Math.min(desiredHeight, maxHeight) - 6) : anchor.bottom + 6,
        width: menuWidth, maxHeight, side: upward ? "top" : "bottom",
      });
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(trigger);
    window.addEventListener("resize", fit);
    window.addEventListener("scroll", fit, true);
    window.visualViewport?.addEventListener("resize", fit);
    window.visualViewport?.addEventListener("scroll", fit);
    return () => {
      observer.disconnect(); window.removeEventListener("resize", fit); window.removeEventListener("scroll", fit, true);
      window.visualViewport?.removeEventListener("resize", fit); window.visualViewport?.removeEventListener("scroll", fit);
    };
  }, [open, optionsKey]);

  useEffect(() => {
    if (open && active >= 0) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, open, listId, position?.maxHeight]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!triggerRef.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    // Capture Escape before the containing dialog's cancel/default action.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation(); setOpen(false); triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", escape, true); };
  }, [open]);

  const choose = (index: number) => {
    const choice = options[index], native = nativeRef.current;
    if (!choice || choice.disabled || !native || triggerRef.current?.matches(":disabled")) return;
    setOpen(false); setError(""); triggerRef.current?.focus();
    if (native.value !== choice.value) {
      native.value = choice.value;
      native.dispatchEvent(new Event("change", { bubbles: true }));
    }
  };
  const move = (from: number, step: number) => {
    for (let index = from + step; index >= 0 && index < options.length; index += step) if (!options[index]!.disabled) return index;
    return from;
  };
  const sections: { label: string | undefined; start: number; entries: Choice[] }[] = [];
  options.forEach((option, index) => {
    const previous = sections.at(-1);
    if (previous && previous.label === option.group) previous.entries.push(option);
    else sections.push({ label: option.group, start: index, entries: [option] });
  });
  const menu = open && typeof document !== "undefined" ? createPortal(
    <div ref={menuRef} id={listId} role="listbox" aria-label={label} aria-labelledby={props["aria-labelledby"]}
      className="single-select-menu" data-side={position?.side}
      style={{ left: position?.left ?? 0, top: position?.top ?? 0, width: position?.width ?? 200, maxHeight: position?.maxHeight ?? 320, visibility: position ? "visible" : "hidden" }}
      onMouseDown={event => event.preventDefault()}>
      {sections.map(section => <div key={section.start} role={section.label ? "group" : undefined} aria-label={section.label}>
        {section.label && <div className="single-select-group" aria-hidden="true">{section.label}</div>}
        {section.entries.map((option, offset) => {
          const index = section.start + offset;
          return <div key={index} id={`${listId}-${index}`} role="option" aria-selected={index === selectedIndex} aria-disabled={option.disabled || undefined}
            className={`single-select-option${active === index ? " active" : ""}`} data-value={option.value}
            onPointerMove={event => { if (event.pointerType === "mouse" && !option.disabled) setActive(index); }}
            onClick={event => { event.preventDefault(); choose(index); }}>
            <span className="single-select-option-content">{renderOption ? renderOption(option.value) : option.label}</span>
            <Check size={16} aria-hidden="true" className={index === selectedIndex ? "" : "single-select-unchecked"} />
          </div>;
        })}
      </div>)}
    </div>, triggerRef.current?.closest("dialog[open]") ?? document.body,
  ) : null;

  return <>
    <button ref={triggerRef} id={controlId} type="button" role="combobox" className={`single-select ${className}`} style={style}
      disabled={disabled} aria-label={label} aria-labelledby={props["aria-labelledby"]}
      aria-describedby={[props["aria-describedby"], error ? `${controlId}-error` : ""].filter(Boolean).join(" ") || undefined}
      aria-invalid={error ? true : props["aria-invalid"]} aria-required={props.required || undefined}
      aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined}
      aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
      data-value={current?.value ?? ""} title={props.title ?? current?.label}
      onClick={() => { search.current = { text: "", at: 0 }; setActive(selectedIndex); setOpen(!open); }}
      onBlur={() => setOpen(false)}
      onKeyDown={event => {
        if (event.key === "Tab") { setOpen(false); return; }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          if (!open) { setOpen(true); setActive(selectedIndex >= 0 && !options[selectedIndex]?.disabled ? selectedIndex : move(event.key === "ArrowDown" ? -1 : options.length, event.key === "ArrowDown" ? 1 : -1)); }
          else setActive(move(active, event.key === "ArrowDown" ? 1 : -1));
        } else if (event.key === "Home" || event.key === "End") {
          event.preventDefault(); setOpen(true); setActive(move(event.key === "Home" ? -1 : options.length, event.key === "Home" ? 1 : -1));
        } else if (event.key === "Enter" || event.key === " ") {
          event.preventDefault(); if (open) choose(active); else { setActive(selectedIndex); setOpen(true); }
        } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          const now = Date.now(), previous = now - search.current.at < 700 ? search.current.text : "";
          const text = (previous + event.key).toLocaleLowerCase();
          search.current = { text, at: now };
          const prefix = [...text].every(char => char === text[0]) ? event.key.toLocaleLowerCase() : text;
          for (let step = 1; step <= options.length; step++) {
            const index = ((open ? active : selectedIndex) + step + options.length) % options.length;
            if (!options[index]!.disabled && options[index]!.label.toLocaleLowerCase().startsWith(prefix)) {
              if (open) setActive(index); else choose(index);
              break;
            }
          }
        }
      }}>
      <span className="single-select-value">{renderValue && current ? renderValue(current.value) : <span className="single-select-text">{current?.label ?? "\u00a0"}</span>}</span>
      <ChevronDown size={16} aria-hidden="true" className="single-select-arrow" />
    </button>
    <select {...props} id={`${controlId}-native`} ref={nativeRef} hidden aria-hidden="true" aria-label={undefined} aria-labelledby={undefined} tabIndex={-1}
      disabled={disabled} value={value} defaultValue={defaultValue}
      onChange={event => { setLocalValue(event.target.value); setError(""); onChange?.(event); }}
      onFocus={() => triggerRef.current?.focus()}
      onInvalid={event => { props.onInvalid?.(event); event.preventDefault(); setError(event.currentTarget.validationMessage); triggerRef.current?.focus(); }}>
      {children}
    </select>
    {error && <span id={`${controlId}-error`} className="single-select-error" role="alert">{error}</span>}
    {menu}
  </>;
}
