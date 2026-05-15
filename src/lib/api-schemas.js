// Shared JSON-Schema definitions used by route response slots so the
// OpenAPI document points to one component per concept instead of inlining
// the same shape over and over.
//
// All schemas here are registered into the Fastify schema store via
// `app.addSchema()` in the swagger plugin. Routes reference them with
// `{ $ref: 'cobs://error-response#' }`. Fastify's `removeAdditional: false`
// and our error-handler plugin together guarantee responses match this
// shape on every error path.
//
// IMPORTANT: $id values double as the OpenAPI component name (last segment),
// so changing them changes the public docs surface. Don't rename casually.

// ---------------------------------------------------------------------------
// Canonical error envelope returned by src/plugins/error-handler.plugin.js.
// Every non-2xx response from this API uses this exact shape.
// ---------------------------------------------------------------------------
export const errorResponseSchema = {
  $id: 'cobs://error-response',
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: {
          type: 'string',
          description: 'Machine-readable error code (stable across versions).',
          examples: ['BAD_REQUEST', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'REQUEST_TIMEOUT', 'VALIDATION_ERROR', 'INTERNAL_ERROR']
        },
        message: {
          type: 'string',
          description: 'Human-readable summary of what went wrong. Safe to display to operators; never leaks internals.'
        },
        details: {
          description: 'Optional structured context. Shape depends on the error code (e.g. field list for VALIDATION_ERROR, conflicting state for CONFLICT).',
          // Permissive — different error codes carry different shapes.
          nullable: true
        }
      }
    }
  }
}

// Convenience helpers so each route declares its error responses with one
// line instead of repeating { $ref: 'cobs://error-response#' } everywhere.
const ref = { $ref: 'cobs://error-response#' }

export const errorResponses = {
  400: { description: 'Validation error or malformed request body.', ...ref },
  401: { description: 'Missing, invalid, or expired bearer token.', ...ref },
  403: { description: 'Authenticated but lacks the required role for this endpoint.', ...ref },
  404: { description: 'Target resource does not exist.', ...ref },
  408: { description: 'Transaction did not complete within its time budget. Retry with the SAME clientRequestId — duplicates are de-duplicated by the idempotency key.', ...ref },
  409: { description: 'State conflict (e.g. fight not OPEN, side on hold, unique constraint violation).', ...ref },
  500: { description: 'Unhandled internal error.', ...ref }
}
