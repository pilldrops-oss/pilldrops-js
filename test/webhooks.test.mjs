import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import {
  listWebhooks, createWebhook, deleteWebhook, testWebhook, setWebhookEnabled,
  listWebhookDeliveries, verifyWebhookSignature,
} from '../dist/index.js'

const opts = { apiUrl: 'http://api', apiKey: 'k' }

function fakeFetch(reply, status = 200) {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method, body: init.body && JSON.parse(init.body), auth: init.headers.Authorization })
    return new Response(JSON.stringify(reply), { status })
  }
  return calls
}

test('webhook methods send the right requests', async () => {
  let calls = fakeFetch({ webhooks: [{ id: 'wh-1' }], deliverable_events: [], signature: {} })
  assert.deepEqual(await listWebhooks(opts), [{ id: 'wh-1' }])
  assert.deepEqual(calls[0], { url: 'http://api/v1/webhooks', method: 'GET', body: undefined, auth: 'Bearer k' })

  calls = fakeFetch({ webhook: { id: 'wh-1' }, secret: 's', shown_once: true, note: 'n' }, 201)
  const created = await createWebhook('https://example.com/hook', ['sandbox.ended'], opts)
  assert.equal(created.secret, 's')
  assert.equal(created.webhook.id, 'wh-1')
  assert.deepEqual(calls[0], {
    url: 'http://api/v1/webhooks', method: 'POST',
    body: { url: 'https://example.com/hook', events: ['sandbox.ended'] }, auth: 'Bearer k',
  })

  calls = fakeFetch({ deleted: 'wh-1' })
  await deleteWebhook('wh-1', opts)
  assert.deepEqual([calls[0].url, calls[0].method], ['http://api/v1/webhooks/wh-1', 'DELETE'])

  calls = fakeFetch({ webhook_id: 'wh-1', status: 500, ok: false, error: 'boom' })
  assert.equal((await testWebhook('wh-1', opts)).ok, false)
  assert.deepEqual([calls[0].url, calls[0].method], ['http://api/v1/webhooks/wh-1/test', 'POST'])

  calls = fakeFetch({ id: 'wh-1', enabled: false })
  assert.deepEqual(await setWebhookEnabled('wh-1', false, opts), { id: 'wh-1', enabled: false })
  assert.deepEqual([calls[0].url, calls[0].method, calls[0].body],
    ['http://api/v1/webhooks/wh-1/toggle', 'POST', { enabled: false }])

  calls = fakeFetch({ deliveries: [{ id: 'd-1' }] })
  assert.deepEqual(await listWebhookDeliveries(opts), [{ id: 'd-1' }])
  assert.deepEqual([calls[0].url, calls[0].method], ['http://api/v1/webhooks/deliveries', 'GET'])
})

test('webhook errors carry the status and server message', async () => {
  fakeFetch({ error: 'events is required' }, 400)
  await assert.rejects(createWebhook('https://example.com/hook', [], opts), /400.*events is required/)
  fakeFetch({ error: 'no such webhook' }, 404)
  await assert.rejects(deleteWebhook('gone', opts), /not found: \/v1\/webhooks\/gone/)
})

test('verifyWebhookSignature', () => {
  const secret = 'whsec_test'
  const body = '{"id":"d-1","type":"sandbox.ended"}'
  const sign = (ts, key = secret) => 'sha256=' + createHmac('sha256', key).update(`${ts}.${body}`).digest('hex')
  const now = String(Math.floor(Date.now() / 1000))

  assert.equal(verifyWebhookSignature(secret, now, sign(now), body), true)
  assert.equal(verifyWebhookSignature(secret, now, sign(now), Buffer.from(body)), true)
  assert.equal(verifyWebhookSignature(secret, now, sign(now), body + ' '), false)
  assert.equal(verifyWebhookSignature(secret, now, sign(now, 'other'), body), false)
  assert.equal(verifyWebhookSignature(secret, now, 'sha256=short', body), false)

  const stale = String(Number(now) - 301)
  assert.equal(verifyWebhookSignature(secret, stale, sign(stale), body), false)
  assert.equal(verifyWebhookSignature(secret, stale, sign(stale), body, 600), true)
  const future = String(Number(now) + 301)
  assert.equal(verifyWebhookSignature(secret, future, sign(future), body), false)
  assert.equal(verifyWebhookSignature(secret, 'abc', sign('abc'), body), false)
})
