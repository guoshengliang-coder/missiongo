import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { androidVector, brandAssets, syncBrandAssets } from "./product-branding.mjs";

test("every checked-in brand artifact matches the canonical artwork and declarations", async () => {
  await syncBrandAssets({ check: true });
});

test("Android conversion preserves stroke geometry and rejects unsupported shapes", () => {
  const vector = androidVector('<svg><g transform="translate(30 30) scale(2)" fill="none" stroke="#172033" stroke-width="2.4" stroke-linecap="round"><path d="M1 2L3 4" /></g></svg>', { adaptive: true });
  assert.match(vector, /viewportWidth="108"/);
  assert.match(vector, /translateX="30"/);
  assert.match(vector, /strokeWidth="2.4"/);
  assert.match(vector, /pathData="M1 2L3 4"/);
  assert.match(vector, /fillColor="#00000000"/);
  assert.throws(() => androidVector('<svg><circle cx="2" cy="2" r="1" /></svg>'), /Unsupported/);
});

test("maskable PWA icons are separate opaque assets with a central rocket", () => {
  const { texts } = brandAssets();
  const manifest = JSON.parse(texts.get("apps/web/public/manifest.webmanifest"));
  assert.equal(manifest.icons.filter((icon) => icon.purpose === "maskable").length, 2);
  assert.ok(manifest.icons.filter((icon) => icon.purpose === "maskable").every((icon) => icon.src.includes("icon-maskable-")));
  const maskable = texts.get("apps/web/public/icon-maskable.svg");
  assert.match(maskable, /M0 0H108V108H0Z/);
  assert.match(maskable, /translate\(27.6 27.6\) scale\(2.2\)/);
});

test("app artwork has mint edges without the header's border or offset shadow", async () => {
  const { texts, product } = brandAssets();
  const source = texts.get(product.icon);
  assert.doesNotMatch(source, /fill="#172033"/);
  const { data, info } = await sharp(Buffer.from(source)).resize(512, 512).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  for (const [x, y] of [[0, 256], [511, 256], [256, 0], [256, 511]]) {
    const offset = (y * info.width + x) * info.channels;
    assert.deepEqual([...data.subarray(offset, offset + 3)], [103, 227, 180]);
  }
});
