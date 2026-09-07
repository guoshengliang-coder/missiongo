import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "./i18n";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// Importing both statically put the whole console into the one chunk the SDK feedback
// form had to download inside a host's WebView, on a phone connection, before it could
// render anything. Only one of the two ever runs, so only one is fetched.
const RootPage = window.location.pathname.startsWith("/sdk/feedback")
  ? lazy(() => import("./SdkFeedback").then(({ SdkFeedbackPage }) => ({ default: SdkFeedbackPage })))
  : lazy(() => import("./App").then(({ App }) => ({ default: App })));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        {/* Both pages draw their own loading state once mounted; a second spinner here
            would only flash between the two. */}
        <Suspense fallback={null}>
          <RootPage />
        </Suspense>
      </I18nProvider>
    </QueryClientProvider>
  </StrictMode>,
);

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js");
  });
}
