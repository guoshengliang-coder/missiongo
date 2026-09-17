import { useEffect, useRef, useState, type DragEvent } from "react";

/**
 * Only a drag carrying files should light up the form. Dragging a text
 * selection or a link across it is not an attachment.
 */
export function dragCarriesFiles(types: Iterable<string> | null | undefined): boolean {
  if (!types) return false;
  for (const type of types) {
    if (type === "Files") return true;
  }
  return false;
}

export type DragDepthEvent = "enter" | "leave" | "drop";

/**
 * Moving between the form's children fires dragleave on the one left and
 * dragenter on the one entered, so a plain boolean flickers. Counting the
 * enters and leaves keeps the overlay up until the pointer truly leaves.
 */
export function nextDragDepth(depth: number, event: DragDepthEvent): number {
  if (event === "enter") return depth + 1;
  if (event === "leave") return Math.max(0, depth - 1);
  return 0;
}

/**
 * Drop files anywhere on a form. While the form is mounted, a file released
 * outside it (the dialog backdrop, a header, the margin) is swallowed instead
 * of letting the browser navigate away to open it and lose the draft.
 */
export function useFileDropZone(onFiles: (files: readonly File[]) => void, { canAccept }: { canAccept: boolean }) {
  const [depth, setDepth] = useState(0);
  const onFilesRef = useRef(onFiles);
  useEffect(() => {
    onFilesRef.current = onFiles;
  }, [onFiles]);

  useEffect(() => {
    const swallow = (event: globalThis.DragEvent) => {
      if (event.defaultPrevented || !dragCarriesFiles(event.dataTransfer?.types)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
      if (event.type === "drop") setDepth(0);
    };
    window.addEventListener("dragover", swallow);
    window.addEventListener("drop", swallow);
    return () => {
      window.removeEventListener("dragover", swallow);
      window.removeEventListener("drop", swallow);
    };
  }, []);

  return {
    isDraggingFiles: depth > 0,
    dropHandlers: {
      onDragEnter: (event: DragEvent<HTMLElement>) => {
        if (!dragCarriesFiles(event.dataTransfer.types)) return;
        event.preventDefault();
        setDepth((current) => nextDragDepth(current, "enter"));
      },
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        if (!dragCarriesFiles(event.dataTransfer.types)) return;
        setDepth((current) => nextDragDepth(current, "leave"));
      },
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (!dragCarriesFiles(event.dataTransfer.types)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = canAccept ? "copy" : "none";
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        if (!dragCarriesFiles(event.dataTransfer.types)) return;
        event.preventDefault();
        setDepth((current) => nextDragDepth(current, "drop"));
        const files = Array.from(event.dataTransfer.files);
        if (files.length > 0) onFilesRef.current(files);
      },
    },
  };
}
