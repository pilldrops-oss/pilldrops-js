import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Sandbox } from '../dist/index.js'

// The server reads "seconds"; any other field became a TTL of 0 and expired the sandbox.
test('setTimeout sends seconds', async () => {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init })
    return new Response(JSON.stringify({ id: 'sb-1' }), { status: 200 })
  }
  const sbx = await Sandbox.connect('sb-1', { apiUrl: 'http://api', apiKey: 'k' })
  await sbx.setTimeout(600)
  const last = calls.at(-1)
  assert.equal(last.url, 'http://api/v1/sandboxes/sb-1/timeout')
  assert.deepEqual(JSON.parse(last.init.body), { seconds: 600 })
})
