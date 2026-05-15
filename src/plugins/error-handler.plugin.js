// Global error handler. Every error thrown inside a route handler ends up
// here and gets mapped to a clean, consistent JSON response with the right
// HTTP status code.
//
// Response shape (always the same):
//   { error: { code, message, details? } }
//
// The `code` is the contract for clients to handle errors programmatically.
// The `message` is human-readable. `details` is optional structured context
// (e.g. validation field errors).
//
// Stack traces are logged on the server but NEVER returned to clients.

import fp from 'fastify-plugin'
import { AppError } from '../lib/errors.js'

async function errorHandlerPlugin(app) {
  app.setErrorHandler((err, request, reply) => {
    // Our own operational errors — trustworthy, send through.
    if (err instanceof AppError) {
      request.log.warn({ err, path: request.url }, `${err.code}: ${err.message}`)
      return reply.status(err.statusCode).send({
        error: { code: err.code, message: err.message, details: err.details ?? undefined }
      })
    }

    // Fastify schema validation failures arrive with err.validation set.
    if (err.validation) {
      request.log.warn({ err, path: request.url }, 'Validation failed')
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: err.validation
        }
      })
    }

    // Prisma known request errors — map common ones explicitly so clients
    // see meaningful codes instead of opaque 500s.
    if (err.code === 'P2002') {
      // Unique constraint violation
      request.log.warn({ err, path: request.url }, 'Unique constraint violation')
      return reply.status(409).send({
        error: {
          code: 'CONFLICT',
          message: 'A record with that value already exists',
          details: { fields: err.meta?.target ?? null }
        }
      })
    }
    if (err.code === 'P2025') {
      // Record not found
      request.log.warn({ err, path: request.url }, 'Record not found')
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: 'Record not found' }
      })
    }

    // Fastify's own errors (empty JSON body, payload too large, content-type
    // mismatch, etc.) arrive with `err.code` starting with FST_ and an
    // explicit 4xx `statusCode`. Respect that — escalating these to 500
    // would hide real client mistakes behind an opaque "server bug" message.
    if (
      typeof err.code === 'string' &&
      err.code.startsWith('FST_') &&
      Number.isInteger(err.statusCode) &&
      err.statusCode >= 400 &&
      err.statusCode < 500
    ) {
      request.log.warn({ err, path: request.url }, `${err.code}: ${err.message}`)
      return reply.status(err.statusCode).send({
        error: { code: err.code, message: err.message }
      })
    }

    // Unknown error — assume it's a real bug. Log full detail server-side,
    // return a generic 500 to the client. Never leak internals.
    request.log.error({ err, path: request.url }, 'Unhandled error')
    return reply.status(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' }
    })
  })
}

export default fp(errorHandlerPlugin, { name: 'error-handler' })
