import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Sandbox, ApiError, listWebhooks } from '../dist/index.js'

// Callers branch on the status (retry a 429, stop on a 403); it used to live only in the message.
test('API failures carry the HTTP status and body', async () => {
  for (const [status, run] of [
    [429, () => Sandbox.create({ apiUrl: 'http://api', apiKey: 'k' })],
    [403, () => listWebhooks({ apiUrl: 'http://api', apiKey: 'k' })],
    [404, () => Sandbox.connect('sb-1', { apiUrl: 'http://api', apiKey: 'k' })],
    [401, () => Sandbox.create({ apiUrl: 'http://api', apiKey: 'k' })],
  ]) {
    globalThis.fetch = async () => new Response('{"error":"nope"}', { status })
    await assert.rejects(run, (err) => {
      assert.ok(err instanceof ApiError, `status ${status}: not an ApiError`)
      assert.ok(err instanceof Error)
      assert.equal(err.status, status)
      assert.equal(err.body, '{"error":"nope"}')
      return true
    })
  }
})
