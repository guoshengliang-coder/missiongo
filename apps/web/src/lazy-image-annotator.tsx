import { lazy, Suspense, type ComponentProps } from "react";
import { ErrorBoundary, LoadFailureNotice } from "./ErrorBoundary";
import type { ImageAnnotator as ImageAnnotatorImpl } from "./ImageAnnotator";

const LazyImageAnnotator = lazy(
  () => import("./ImageAnnotator").then(({ ImageAnnotator }) => ({ default: ImageAnnotator })),
);

/** Keep the editor off the cold path and contain failures across deployments. */
export function ImageAnnotator(props: ComponentProps<typeof ImageAnnotatorImpl>) {
  return <ErrorBoundary fallback={error => <LoadFailureNotice error={error} onDismiss={props.onCancel} />}>
    <Suspense fallback={null}><LazyImageAnnotator {...props} /></Suspense>
  </ErrorBoundary>;
}
