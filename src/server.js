/**
 * HTTP layer.
 *
 * Deliberately thin: parse, route, serialise, and handle transport-level errors.
 * No business logic lives here, which is what allows the route handlers to be
 * tested as plain functions as well as over a real socket.
 */

import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createApp } from './app.js';
import { handleGenerate } from './routes/generate.js';
import { handleMetrics, handleMetricsReset } from './routes/metrics.js';

/** Reject oversized bodies before buffering them (decision D19). */
const MAX_BODY_BYTES = 1_000_000;

/**
 * Read and JSON-parse a request body.
 * @returns {Promise<{ok: true, value: object} | {ok: false, error: string}>}
 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve({ ok: false, error: 'payload_too_large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim().length === 0) return resolve({ ok: true, value: {} });
      try {
        resolve({ ok: true, value: JSON.parse(raw) });
      } catch {
        resolve({ ok: false, error: 'malformed_json' });
      }
    });

    req.on('error', () => resolve({ ok: false, error: 'read_failed' }));
  });
}

/** Write a JSON response with a consistent envelope. */
function sendJson(res, { status, headers = {}, body }) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

/**
 * Build an HTTP server around a wired app.
 *
 * @param {object} [configOverrides] partial config passed through to `createApp`
 * @param {object} [deps] a pre-built app, for tests that need to reach inside it
 * @returns {{server: import('node:http').Server, deps: object}}
 */
export function createServer(configOverrides = {}, deps = createApp(configOverrides)) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const route = `${req.method} ${url.pathname}`;

    try {
      switch (route) {
        case 'POST /api/generate': {
          const parsed = await readJsonBody(req);
          if (!parsed.ok) {
            return sendJson(res, {
              status: parsed.error === 'payload_too_large' ? 413 : 400,
              body: { error: parsed.error, message: 'Request body could not be read as JSON.' },
            });
          }
          return sendJson(res, await handleGenerate(deps, parsed.value));
        }

        case 'GET /api/metrics':
          return sendJson(res, handleMetrics(deps));

        case 'POST /api/metrics/reset':
          return sendJson(res, handleMetricsReset(deps));

        case 'GET /api/health':
          return sendJson(res, {
            status: 200,
            body: { ok: true, circuitBreaker: deps.breaker.state },
          });

        default:
          return sendJson(res, {
            status: 404,
            body: {
              error: 'not_found',
              message: `No route for ${route}.`,
              routes: [
                'POST /api/generate',
                'GET /api/metrics',
                'POST /api/metrics/reset',
                'GET /api/health',
              ],
            },
          });
      }
    } catch (error) {
      // Last-resort guard. A bug in a handler must not take the process down —
      // this proxy exists to keep traffic flowing when things go wrong.
      return sendJson(res, {
        status: 500,
        body: { error: 'internal_error', message: String(error?.message ?? error) },
      });
    }
  });

  return { server, deps };
}

/** Entry point used by `npm start`. */
export function start(configOverrides = {}) {
  const { server, deps } = createServer(configOverrides);
  const port = deps.config.server.port;
  server.listen(port, () => {
    console.log(`AI Rate Limiter proxy listening on http://localhost:${port}`);
    console.log(`  POST /api/generate       - proxied generation`);
    console.log(`  GET  /api/metrics        - live metrics`);
    console.log(`  POST /api/metrics/reset  - reset counters and breaker`);
    console.log(
      `  limits: ${deps.config.rateLimit.softMaxRequests} req/min soft, ` +
        `${deps.config.rateLimit.hardMaxRequests} req/min hard`,
    );
  });
  return { server, deps };
}

// Run only when executed directly, not when imported by a test.
// pathToFileURL is required rather than a string comparison: on Windows the path
// can contain spaces, which import.meta.url percent-encodes and argv[1] does not.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start();
}
