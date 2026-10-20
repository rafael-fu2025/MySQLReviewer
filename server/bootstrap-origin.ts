/**
 * Gate for the unauthenticated `/api/bootstrap` endpoint that hands out the
 * session token. Only the app itself may call it: the browser must report a
 * same-origin fetch, or send an Origin that is on the local allowlist (the Vite
 * dev server talks to the API cross-origin).
 */
export interface BootstrapOriginInput {
  /** `Origin` request header, if any. */
  origin?: string | null;
  /** `Sec-Fetch-Site` request header, if any. */
  secFetchSite?: string | null;
  /** Origin implied by the request's protocol + Host header. */
  expectedOrigin: string;
  /** Locally trusted origins (dev server and loopback origins). */
  allowedOrigins: ReadonlySet<string>;
}

export function isBootstrapRequestAllowed(input: BootstrapOriginInput): boolean {
  const site = (input.secFetchSite ?? '').trim().toLowerCase();
  if (site === 'same-origin') return true;

  const origin = (input.origin ?? '').trim();
  if (!origin) return false;
  if (origin === input.expectedOrigin) return true;
  return input.allowedOrigins.has(origin);
}
