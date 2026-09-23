// heic-decode ships no typings. This is the part of its API the server uses:
// decode the first image of a HEIC/HEIF container into RGBA pixels.
declare module "heic-decode" {
  interface DecodedImage {
    readonly width: number;
    readonly height: number;
    readonly data: Uint8ClampedArray;
  }
  function decode(input: { readonly buffer: ArrayBufferLike | Uint8Array }): Promise<DecodedImage>;
  export default decode;
}
