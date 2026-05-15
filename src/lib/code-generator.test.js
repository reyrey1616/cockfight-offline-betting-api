import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ALPHABET, generateUniqueCode } from './code-generator.js'

describe('generateUniqueCode', () => {
  it('builds an 8-char advance code (prefix + 5 random)', async () => {
    const code = await generateUniqueCode({
      prefix: 'ADV',
      isUsed: async () => false
    })
    assert.equal(code.length, 8)
    assert.match(code, /^ADV[A-Z0-9]{5}$/)
    for (const ch of code.slice(3)) {
      assert.ok(ALPHABET.includes(ch), `unexpected char ${ch}`)
    }
  })

  it('retries when isUsed returns true', async () => {
    let calls = 0
    const code = await generateUniqueCode({
      prefix: 'REM',
      isUsed: async () => {
        calls += 1
        return calls === 1
      }
    })
    assert.equal(calls, 2)
    assert.match(code, /^REM/)
  })
})
