/**
 * Gate for the unauthenticated `/api/bootstrap` endpoint that hands out the
 * session token. Only the app itself may call it: the browser must report a
 * same-origin fetch, or send an Origin that is on the local allowlist (the Vite
 * dev server talks to the API cross-origin).
 *
 * Some mobile browsers (OEM builds, WebView variants, proxy/acceleration
 * modes) strip or never send Fetch-Metadata and Origin on same-origin
 * requests — over a LAN those browsers would be locked out of the sign-in
 * screen entirely. For metadata-less requests the gate falls back to the
 * app's own fetch signature: a GET asking for `application/json` (the SPA's
 * exact Accept header). Anything that explicitly reports itself cross-site
 * stays out, and curl-style clients asking for any content type still do.
 */
export interface BootstrapOriginInput {
  /** `Origin` request header, if any. */
  origin?: string | null;
  /** `Sec-Fetch-Site` request header, if any. */
  secFetchSite?: string | null;
  /** `Accept` request header, if any. */
  accept?: string | null;
  /** Origin implied by the request's protocol + Host header. */
  expectedOrigin: string;
  /** Locally trusted origins (dev server and loopback origins). */
  allowedOrigins: ReadonlySet<string>;
}

export function isBootstrapRequestAllowed(input: BootstrapOriginInput): boolean {
  const site = (input.secFetchSite ?? '').trim().toLowerCase();
  if (site === 'same-origin') return true;

  const origin = (input.origin ?? '').trim();
  if (origin && (origin === input.expectedOrigin || input.allowedOrigins.has(origin))) {
    return true;
  }

  // No Fetch-Metadata and no usable Origin: only the app's own fetch
  // signature gets through, and only when the browser did not explicitly
  // declare the request as coming from another site.
  if (site && site !== 'none') return false;
  const accept = (input.accept ?? '').toLowerCase();
  return accept.includes('application/json');
}
