import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Sandbox } from '../dist/index.js'

// A stripped leading slash sent /tmp/a.txt to <home>/tmp/a.txt without a word.
test('absolute paths are sent unchanged', async () => {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, body: init.body })
    return new Response(JSON.stringify({ id: 'sb-1', exit_code: 0 }), { status: 200 })
  }
  const sbx = await Sandbox.connect('sb-1', { apiUrl: 'http://api', apiKey: 'k' })
  const dir = mkdtempSync(join(tmpdir(), 'sdk-paths-'))
  writeFileSync(join(dir, 'a.txt'), 'A')

  await sbx.writeFile('/root/a.txt', 'A')
  await sbx.readFile('/root/a.txt')
  await sbx.upload(join(dir, 'a.txt'), '/root/b.txt')
  await sbx.upload(dir, '/app')

  const urls = calls.map((c) => c.url)
  const filesURL = (p) => `http://api/v1/sandboxes/sb-1/files?path=${encodeURIComponent(p)}`
  assert.equal(urls.filter((u) => u === filesURL('/root/a.txt')).length, 2)
  assert.ok(urls.includes(filesURL('/root/b.txt')))
  const exec = calls.find((c) => c.url.endsWith('/exec'))
  assert.match(JSON.parse(exec.body).cmd, /^mkdir -p \/app && tar -xzf \S+ -C \/app /)
})
