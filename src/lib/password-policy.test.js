import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { BadRequestError } from './errors.js'
import { assertPasswordPolicy, MIN_PASSWORD_LENGTH } from './password-policy.js'

describe('assertPasswordPolicy', () => {
  it('accepts a strong password', () => {
    assert.doesNotThrow(() => assertPasswordPolicy('MySecurePass1'))
  })

  it('rejects passwords shorter than minimum', () => {
    assert.throws(
      () => assertPasswordPolicy('short'),
      (err) => err instanceof BadRequestError && err.message.includes(String(MIN_PASSWORD_LENGTH))
    )
  })

  it('rejects common weak passwords', () => {
    assert.throws(
      () => assertPasswordPolicy('password'),
      (err) => err instanceof BadRequestError && /too common/i.test(err.message)
    )
  })
})
