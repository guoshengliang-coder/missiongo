import { PRODUCT_NAME, PRODUCT_TAGLINES } from "./branding.generated";
import type { Locale } from "./i18n";

export function productMetadata(locale: Locale) {
  return {
    title: `${PRODUCT_NAME} · ${PRODUCT_TAGLINES[locale]}`,
    description: `${PRODUCT_NAME} — ${PRODUCT_TAGLINES[locale]}`,
    manifest: locale === "en" ? "/manifest-en.webmanifest" : "/manifest.webmanifest",
    socialImage: locale === "en" ? "/og-en.png" : "/og.png",
  };
}

export function applyProductMetadata(document: Document, locale: Locale) {
  const metadata = productMetadata(locale);
  document.title = metadata.title;
  for (const selector of ['meta[name="description"]', 'meta[property="og:description"]', 'meta[name="twitter:description"]']) {
    document.querySelector(selector)?.setAttribute("content", metadata.description);
  }
  document.querySelector('link[rel="manifest"]')?.setAttribute("href", metadata.manifest);
  for (const selector of ['meta[property="og:image"]', 'meta[name="twitter:image"]']) {
    document.querySelector(selector)?.setAttribute("content", new URL(metadata.socialImage, document.baseURI).href);
  }
}
