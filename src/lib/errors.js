// Custom error classes used throughout the app. Every operational failure
// should `throw new <SpecificError>(...)` instead of returning ad-hoc objects
// or generic Errors. The global error-handler plugin maps these into clean
// JSON responses with the right HTTP status code.
//
// Operational errors carry `code` (machine-readable) and `details` (optional
// structured context). Stack traces are NEVER sent to clients in production.

export class AppError extends Error {
  constructor(message, { statusCode = 500, code = 'INTERNAL_ERROR', details = null } = {}) {
    super(message)
    this.name = this.constructor.name
    this.statusCode = statusCode
    this.code = code
    this.details = details
    this.expose = true
    Error.captureStackTrace?.(this, this.constructor)
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request', details = null) {
    super(message, { statusCode: 400, code: 'BAD_REQUEST', details })
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized', details = null) {
    super(message, { statusCode: 401, code: 'UNAUTHORIZED', details })
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden', details = null) {
    super(message, { statusCode: 403, code: 'FORBIDDEN', details })
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found', details = null) {
    super(message, { statusCode: 404, code: 'NOT_FOUND', details })
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict', details = null) {
    super(message, { statusCode: 409, code: 'CONFLICT', details })
  }
}

// Used when a write transaction can't acquire the row lock or finish within
// its timeout — caller is expected to retry the same request idempotently
// (with the same clientRequestId).
export class RequestTimeoutError extends AppError {
  constructor(message = 'System busy, please retry', details = null) {
    super(message, { statusCode: 408, code: 'REQUEST_TIMEOUT', details })
  }
}

// Use for invariant violations that indicate a real bug in service logic
// (e.g. illegal state transition that should have been caught earlier).
// These bubble up as 500s but are tagged so we can find them in logs.
export class InvariantError extends AppError {
  constructor(message = 'Invariant violated', details = null) {
    super(message, { statusCode: 500, code: 'INVARIANT', details })
  }
}
