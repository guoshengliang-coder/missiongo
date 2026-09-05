/**
 * Resolve the Fastify `trustProxy` setting from a TRUST_PROXY value.
 *
 * Fastify deliberately treats a numeric hop count as "trust nothing", because a
 * hop count cannot validate the immediate peer. Reject digits explicitly so a
 * value like `TRUST_PROXY=2` fails loudly instead of silently disabling every
 * X-Forwarded-* header.
 *
 * `true` trusts X-Forwarded-For from any peer, which lets a client claim any
 * address. Prefer an explicit list of trusted proxy addresses, CIDR ranges, or
 * named ranges such as `loopback` and `uniquelocal`.
 */
export function trustProxySetting(value: string | undefined): boolean | string {
  const raw = value?.trim();
  if (!raw || raw === "false") return false;
  if (raw === "true") return true;
  if (/^\d+$/.test(raw)) {
    throw new Error(
      "TRUST_PROXY must be false, true, or a comma-separated list of trusted proxy addresses, "
      + "CIDR ranges, or named ranges such as loopback and uniquelocal. "
      + "Fastify ignores numeric hop counts.",
    );
  }
  return raw;
}
