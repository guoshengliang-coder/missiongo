# Product branding

`product.json` declares `iconSource`, the published `icon` path, and both
localized taglines. `icon.svg` is flat app artwork with a centered mint tile,
Lucide diagonal rocket; it contains neither an outer border nor an offset shadow.
The glyph is enlarged and its stroke reduced relative to its body for small-size legibility.
The rocket group uses Lucide's
24-unit coordinates; its license is included beside the source.

After editing those declarations or artwork, run `npm run generate:branding`.
Commit the generated Web resources, Android vectors, TypeScript constants,
social-card SVGs and raster receipt together. Do not edit generated copies.
`npm run check:identity` verifies their source digest, exact vector/text content,
PNG hashes and dimensions. Social-card PNGs are checked by receipt rather than
rerendered on every OS, where installed fonts differ.

The shared Web `Brand` uses the same versioned icon URL as the favicon and adds
its thin border and offset shadow only through CSS at a 36px display size. Separate
opaque maskable PNGs and the Android adaptive foreground center the rocket in
the safe area; launcher masks supply their own shape. The SDK sample retains
its separate gold identity. macOS packaging reads the generated 1024px PNG,
creates all ICNS sizes, and fails if the product icon is absent.

The default HTML/manifest/share card are Chinese. The existing i18n provider
selects the matching title, description, manifest and share image through
`branding.ts`; English translations/assets are maintained without changing the
product's current Chinese-only locale policy. Browser/share-client caches and
installed launcher icons still need verification on actual updated clients.
