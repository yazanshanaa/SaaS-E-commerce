import http from 'node:http';
import type { Page } from '@playwright/test';
import { E2E } from './env';

/**
 * Two ways to make a request, for two different jobs.
 *
 * Playwright's `request` fixture resolves DNS in the Node process, so it cannot see Chromium's
 * `--host-resolver-rules` and cannot reach `app.souqbartaa.test`. That leaves:
 *
 *   - `browserFetch` — issued BY the page, so it uses the browser's resolver and the browser's
 *     cookie jar. This is what auth flows need: a session cookie has to land where a
 *     subsequent navigation will find it.
 *   - `rawRequest`   — a bare Node request with a hand-written Host header, which is the only
 *     way to send a header a browser refuses to set. Used to prove the proxy ignores forged
 *     tenant headers.
 */

export interface FetchResult {
  status: number;
  body: string;
  headers: Record<string, string>;
}

export async function browserFetch(
  page: Page,
  path: string,
  init?: { method?: string; json?: unknown },
): Promise<FetchResult> {
  return page.evaluate(
    async ({ path: p, init: i }) => {
      const response = await fetch(p, {
        method: i?.method ?? 'GET',
        headers: i?.json ? { 'content-type': 'application/json' } : undefined,
        body: i?.json ? JSON.stringify(i.json) : undefined,
      });

      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });

      return { status: response.status, body: await response.text(), headers };
    },
    { path, init },
  );
}

export function rawRequest(options: {
  path: string;
  host: string;
  headers?: Record<string, string>;
}): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port: E2E.webPort,
        path: options.path,
        method: 'GET',
        headers: { host: options.host, ...options.headers },
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            body,
            headers: response.headers as Record<string, string>,
          }),
        );
      },
    );

    request.on('error', reject);
    request.end();
  });
}

/**
 * A POST straight down the socket, with headers a browser would send and Playwright will not let
 * a page forge.
 *
 * It exists because Phase 6's Content-Security-Policy made one of A2's tests impossible to write
 * from inside a page: `form-action 'self'` refuses a cross-origin form submit, so a storefront can
 * no longer CONSTRUCT the forged consent post that the endpoint's `Sec-Fetch-Site` check exists to
 * refuse. That is the policy working — and a real attacker's page carries no policy of ours, so
 * blocking our own test removed the ability to prove the control without removing the attack.
 *
 * The control being tested is server-side, so the request is sent server-side, byte for byte as a
 * cross-site form post arrives: `text/plain`, no preflight, `Sec-Fetch-Site: cross-site`.
 */
export function rawPost(options: {
  path: string;
  host: string;
  body: string;
  headers?: Record<string, string>;
}): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(options.body, 'utf8');

    const request = http.request(
      {
        host: '127.0.0.1',
        port: E2E.webPort,
        path: options.path,
        method: 'POST',
        headers: {
          host: options.host,
          'content-type': 'text/plain;charset=UTF-8',
          'content-length': String(payload.byteLength),
          'sec-fetch-site': 'cross-site',
          'sec-fetch-mode': 'navigate',
          ...options.headers,
        },
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            body,
            headers: response.headers as Record<string, string>,
          }),
        );
      },
    );

    request.on('error', reject);
    request.write(payload);
    request.end();
  });
}
