import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ApiError, listFunctions, getFunction, createFunction, updateFunction, deleteFunction,
  invokeFunction, renameFunction, listFunctionDeployments, rollbackFunction, publicInvokeUrl,
} from '../dist/index.js'

const opts = { apiUrl: 'http://api', apiKey: 'k' }

function fakeFetch(reply, status = 200) {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    const headers = new Headers(init.headers)
    calls.push({ url, method: init.method, body: init.body && JSON.parse(init.body), auth: headers.get('Authorization') })
    return new Response(typeof reply === 'string' ? reply : JSON.stringify(reply), { status })
  }
  return calls
}

test('function methods send the right requests', async () => {
  let calls = fakeFetch({ functions: [{ name: 'hello' }] })
  assert.deepEqual(await listFunctions(opts), [{ name: 'hello' }])
  assert.deepEqual(calls[0], { url: 'http://api/v1/functions', method: 'GET', body: undefined, auth: 'Bearer k' })

  calls = fakeFetch({ name: 'hello', public_id: '' })
  assert.equal((await getFunction('hello', opts)).name, 'hello')
  assert.deepEqual(calls[0], { url: 'http://api/v1/functions/hello', method: 'GET', body: undefined, auth: 'Bearer k' })

  calls = fakeFetch({ name: 'hello' }, 201)
  const spec = { name: 'hello', start: 'node index.js', port: 3000, public: true, files: [{ path: 'index.js', content: 'x' }] }
  assert.equal((await createFunction(spec, opts)).name, 'hello')
  assert.deepEqual(calls[0], { url: 'http://api/v1/functions', method: 'POST', body: spec, auth: 'Bearer k' })

  calls = fakeFetch({ status: 'updated' })
  await updateFunction('hello', { public: false, env: {} }, opts)
  assert.deepEqual(calls[0], {
    url: 'http://api/v1/functions/hello', method: 'PUT', body: { public: false, env: {} }, auth: 'Bearer k',
  })

  calls = fakeFetch({ status: 'deleted' })
  await deleteFunction('hello', opts)
  assert.deepEqual(calls[0], { url: 'http://api/v1/functions/hello', method: 'DELETE', body: undefined, auth: 'Bearer k' })

  calls = fakeFetch({ name: 'world', old_name_forwards_until: 1700000000 })
  assert.deepEqual(await renameFunction('hello', 'world', opts), { name: 'world', old_name_forwards_until: 1700000000 })
  assert.deepEqual(calls[0], {
    url: 'http://api/v1/functions/hello/rename', method: 'POST', body: { name: 'world' }, auth: 'Bearer k',
  })

  calls = fakeFetch({ deployments: [{ id: 'd2' }, { id: 'd1' }] })
  assert.deepEqual(await listFunctionDeployments('hello', opts), [{ id: 'd2' }, { id: 'd1' }])
  assert.deepEqual(calls[0], {
    url: 'http://api/v1/functions/hello/deployments', method: 'GET', body: undefined, auth: 'Bearer k',
  })

  calls = fakeFetch({ status: 'rolled back' })
  await rollbackFunction('hello', 'd1', opts)
  assert.deepEqual(calls[0], {
    url: 'http://api/v1/functions/hello/deployments/d1/rollback', method: 'POST', body: undefined, auth: 'Bearer k',
  })
})

test('function names and deployment ids are URL-encoded', async () => {
  const calls = fakeFetch({ status: 'rolled back' })
  await getFunction('a/b c', opts)
  await rollbackFunction('a/b', 'd?1', opts)
  await invokeFunction('a/b', {}, opts)
  assert.deepEqual(calls.map((c) => c.url), [
    'http://api/v1/functions/a%2Fb%20c',
    'http://api/v1/functions/a%2Fb/deployments/d%3F1/rollback',
    'http://api/v1/functions/a%2Fb/invoke',
  ])
})

test('invokeFunction returns the handler response as is', async () => {
  let seen
  globalThis.fetch = async (url, init = {}) => {
    seen = { url, method: init.method, body: init.body, headers: new Headers(init.headers) }
    return new Response('teapot', { status: 418, headers: { 'x-handler': 'yes' } })
  }
  const res = await invokeFunction('hello', {
    path: '/users/1?full=1', method: 'POST', body: 'hi', headers: { 'Content-Type': 'text/plain' },
  }, opts)
  assert.equal(res.status, 418)
  assert.equal(res.headers.get('x-handler'), 'yes')
  assert.equal(await res.text(), 'teapot')
  assert.equal(seen.url, 'http://api/v1/functions/hello/invoke/users/1?full=1')
  assert.equal(seen.method, 'POST')
  assert.equal(seen.body, 'hi')
  assert.equal(seen.headers.get('Authorization'), 'Bearer k')
  assert.equal(seen.headers.get('Content-Type'), 'text/plain')

  await invokeFunction('hello', {}, opts)
  assert.equal(seen.url, 'http://api/v1/functions/hello/invoke')
  assert.equal(seen.method, 'POST')
})

test('function errors are ApiErrors with the status', async () => {
  for (const [status, run] of [
    [404, () => getFunction('gone', opts)],
    [409, () => rollbackFunction('hello', 'd1', opts)],
    [400, () => createFunction({ name: 'x', start: '' }, opts)],
  ]) {
    fakeFetch('{"error":"nope"}', status)
    await assert.rejects(run, (err) => {
      assert.ok(err instanceof ApiError, `status ${status}: not an ApiError`)
      assert.equal(err.status, status)
      assert.equal(err.body, '{"error":"nope"}')
      return true
    })
  }
})

test('publicInvokeUrl builds the key-less URL without calling the API', () => {
  globalThis.fetch = async () => assert.fail('publicInvokeUrl must not send a request')
  assert.equal(publicInvokeUrl({ public_id: 'p/1' }, 'http://api/'), 'http://api/v1/public/functions/p%2F1/invoke')
  assert.equal(publicInvokeUrl('p1', 'http://api'), 'http://api/v1/public/functions/p1/invoke')
  assert.throws(() => publicInvokeUrl({ public_id: '' }, 'http://api'), /not public/)
})
