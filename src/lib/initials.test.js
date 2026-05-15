import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { InvariantError } from './errors.js'
import { deriveInitials } from './initials.js'

describe('deriveInitials', () => {
  it('returns first three letters uppercased', () => {
    assert.equal(deriveInitials('juan'), 'JUA')
    assert.equal(deriveInitials('TellerOne'), 'TEL')
  })

  it('rejects usernames shorter than three characters', () => {
    assert.throws(() => deriveInitials('ab'), InvariantError)
  })
})
