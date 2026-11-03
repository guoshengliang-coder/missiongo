import { useRef, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { OverlayDialog } from "./overlay";
import { useI18n } from "./i18n";

export function MediaLightbox({
  title,
  onClose,
  onPrevious,
  onNext,
  showNavigation = false,
  children,
  actions,
}: {
  title: string;
  onClose: () => void;
  onPrevious?: (() => void) | undefined;
  onNext?: (() => void) | undefined;
  showNavigation?: boolean;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const { t } = useI18n();
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  return (
    <OverlayDialog
      onClose={onClose}
      className="selected-media-lightbox"
      aria-label={title}
      onMouseDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (!showNavigation || event.target instanceof HTMLVideoElement) return;
        const navigate = event.key === "ArrowLeft" ? onPrevious : event.key === "ArrowRight" ? onNext : undefined;
        if (navigate) {
          event.preventDefault();
          navigate();
        }
      }}
      onTouchStart={(event) => {
        const zoomed = event.target instanceof Element && event.target.closest('[data-zoomed="true"]');
        if (!showNavigation || event.touches.length !== 1 || zoomed || (event.target instanceof Element && Boolean(event.target.closest("button, video, input, a")))) { touchStart.current = null; return; }
        touchStart.current = { x: event.touches[0]!.clientX, y: event.touches[0]!.clientY };
      }}
      onTouchMove={(event) => {
        if (event.touches.length > 1 || (event.target instanceof Element && event.target.closest('[data-zoomed="true"]'))) touchStart.current = null;
      }}
      onTouchCancel={() => { touchStart.current = null; }}
      onTouchEnd={(event) => {
        const start = touchStart.current;
        touchStart.current = null;
        if (!start || !showNavigation || event.changedTouches.length !== 1) return;
        const dx = event.changedTouches[0]!.clientX - start.x;
        const dy = event.changedTouches[0]!.clientY - start.y;
        if (Math.abs(dx) < 55 || Math.abs(dx) < Math.abs(dy) * 1.25) return;
        (dx > 0 ? onPrevious : onNext)?.();
      }}
    >
      <section>
        <header>
          <strong>{title}</strong>
          {actions}
          <button type="button" onClick={onClose} aria-label={t("closePreview")}><X size={20} /></button>
        </header>
        {showNavigation ? (
          <div className="media-gallery-stage">
            {children}
            <button type="button" className="media-gallery-nav previous" disabled={!onPrevious} onClick={onPrevious} aria-label={t("previousMedia")}><ChevronLeft size={24} /></button>
            <button type="button" className="media-gallery-nav next" disabled={!onNext} onClick={onNext} aria-label={t("nextMedia")}><ChevronRight size={24} /></button>
          </div>
        ) : children}
      </section>
    </OverlayDialog>
  );
}

