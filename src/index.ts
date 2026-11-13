/**
 * PillDrops — JavaScript/TypeScript SDK for AI-native sandboxes (pilldrops.com).
 *
 * ```ts
 * import { Sandbox } from '@pilldrops/sdk'
 *
 * const sb = await Sandbox.create({ template: 'python-3.11' })
 * const r = await sb.run("python3 -c 'print(2+2)'")
 * console.log(r.stdout)          // 4
 * await sb.upload('./app', 'app')
 * await sb.kill()
 *
 * // App server + public preview URL:
 * const app = await Sandbox.create({ template: 'node-20', start: 'npm run dev', ports: [3000] })
 * console.log(app.url)           // https://.../preview/<id>/3000/
 * ```
 *
 * Credentials resolve from (in order): explicit opts, PILLDROPS_API_URL/
 * PILLDROPS_API_KEY env (SANDFORGE_/E2B_/SANDBOX_ fallbacks), then
 * ~/.sandforge/config.json (written by `pilldrops login`).
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHmac, timingSafeEqual } from 'node:crypto'

export interface Config {
  apiUrl: string
  key: string
}

export function config(): Config {
  const env = (n: string) => process.env[n] || ''
  let apiUrl = env('PILLDROPS_API_URL') || env('SANDFORGE_API_URL') || env('E2B_API_URL') || env('SANDBOX_API_URL')
  let key = env('PILLDROPS_API_KEY') || env('SANDFORGE_API_KEY') || env('E2B_API_KEY') || env('SANDBOX_API_KEY')
  if (!apiUrl || !key) {
    try {
      const p = process.env.SANDFORGE_CONFIG || join(homedir(), '.sandforge', 'config.json')
      const c = JSON.parse(readFileSync(p, 'utf8'))
      apiUrl = apiUrl || c.api_url || ''
      key = key || c.key || ''
    } catch { /* not logged in — caller must pass creds */ }
  }
  return { apiUrl: apiUrl.replace(/\/+$/, ''), key }
}

export interface CreateOptions {
  template?: string
  image?: string
  start?: string
  ports?: number[]
  env?: Record<string, string> | string[]
  vcpu?: number
  memMb?: number
  storageMb?: number
  timeout?: number
  apiUrl?: string
  apiKey?: string
}

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
  truncated: boolean
  readonly ok: boolean
}

function mkResult(d: any): ExecResult {
  const exitCode = d.exit_code ?? -1
  return {
    stdout: d.stdout ?? '',
    stderr: d.stderr ?? '',
    exitCode,
    truncated: d.truncated ?? false,
    get ok() { return exitCode === 0 },
  }
}

export class Sandbox {
  readonly id: string
  private base: string
  private key: string
  private info: any

  private constructor(id: string, base: string, key: string, info: any) {
    this.id = id
    this.base = base
    this.key = key
    this.info = info || {}
  }

  /** Public preview URL for the app port (undefined until a port is published). */
  get url(): string | undefined { return this.info.url || this.info.app_url }
  get template(): string { return this.info.template || '' }
  get status(): string { return this.info.status || this.info.state || '' }

  static async create(opts: CreateOptions = {}): Promise<Sandbox> {
    const cfg = config()
    const base = (opts.apiUrl || cfg.apiUrl).replace(/\/+$/, '')
    const key = opts.apiKey || cfg.key
    if (!base) throw new Error('no API URL — set PILLDROPS_API_URL to your PillDrops server')

    const body: Record<string, unknown> = { template: opts.template || 'python-3.11', client: 'sdk' }
    if (opts.image) body.image = opts.image
    if (opts.start) body.start = opts.start
    if (opts.ports?.length) body.ports = opts.ports
    if (opts.env) {
      body.env = Array.isArray(opts.env) ? opts.env
        : Object.entries(opts.env).map(([k, v]) => `${k}=${v}`)
    }
    if (opts.vcpu) body.vcpu = opts.vcpu
    if (opts.memMb) body.memory_mb = opts.memMb
    if (opts.storageMb) body.storage_mb = opts.storageMb
    if (opts.timeout) body.timeout = opts.timeout

    const res = await fetch(`${base}/v1/sandboxes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(body),
    })
    if (res.status === 401) throw new Error('invalid API key — run `pilldrops login`')
    if (!res.ok) throw new Error(`create failed (${res.status}): ${await res.text()}`)
    const data: any = await res.json()
    return new Sandbox(data.id, base, key, data)
  }

  private async req(method: string, path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      ...init,
      headers: { ...(this.key ? { Authorization: `Bearer ${this.key}` } : {}), ...(init.headers || {}) },
    })
    if (res.status === 404) throw new Error(`not found: ${path}`)
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`)
    return res
  }

  async run(cmd: string, cwd = '', timeout = 60,
            env?: Record<string, string>): Promise<ExecResult> {
    const body: Record<string, unknown> = { cmd, cwd, timeout }
    if (env && Object.keys(env).length) body.env = env  // per-command env (E2B envs= parity)
    const res = await this.req('POST', `/v1/sandboxes/${this.id}/exec`, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return mkResult(await res.json())
  }

  /** Public preview URL for any guest port (E2B getHost parity). Multi-port
   * sandboxes reach every bound port at <port>-<id>. */
  host(port: number): string {
    const u = this.url || ''
    const m = u.match(/^(https?):\/\/([^/]+)/)
    if (m) {
      const hostpart = m[2]
      const dot = hostpart.indexOf('.')
      if (dot > 0 && hostpart.slice(0, dot).includes('-')) {
        return `${m[1]}://${port}-${this.id}.${hostpart.slice(dot + 1)}`
      }
    }
    return `${this.base}/preview/${this.id}/${port}/`
  }

  /** Reattach to an existing sandbox by id (E2B Sandbox.connect parity). */
  static async connect(sandboxId: string, opts: { apiUrl?: string; apiKey?: string } = {}): Promise<Sandbox> {
    const cfg = config()
    const base = (opts.apiUrl || cfg.apiUrl).replace(/\/+$/, '')
    const key = opts.apiKey || cfg.key
    const res = await fetch(`${base}/v1/sandboxes/${sandboxId}`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
    })
    if (res.status === 404) throw new Error(`sandbox not found: ${sandboxId}`)
    if (!res.ok) throw new Error(`connect failed (${res.status}): ${await res.text()}`)
    return new Sandbox(sandboxId, base, key, await res.json())
  }

  /** List the caller's sandboxes (E2B Sandbox.list parity). */
  static async list(opts: { apiUrl?: string; apiKey?: string } = {}): Promise<any[]> {
    const cfg = config()
    const base = (opts.apiUrl || cfg.apiUrl).replace(/\/+$/, '')
    const key = opts.apiKey || cfg.key
    const res = await fetch(`${base}/v1/sandboxes`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
    })
    if (!res.ok) throw new Error(`list failed (${res.status}): ${await res.text()}`)
    const data: any = await res.json()
    return Array.isArray(data) ? data : (data.sandboxes || [])
  }

  /** Write a snippet to a workspace file and run it. */
  async runCode(code: string, lang: 'python' | 'node' | 'bash' = 'python'): Promise<ExecResult> {
    const ext = { python: 'py', node: 'js', bash: 'sh' }[lang]
    const runner = { python: 'python3', node: 'node', bash: 'bash' }[lang]
    const name = `_sf_${Date.now()}.${ext}`
    await this.writeFile(name, code)
    return this.run(`${runner} ${name}`)
  }

  /** Write file content. Paths are relative to the sandbox home; an absolute path must be inside it. */
  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    await this.req('POST', `/v1/sandboxes/${this.id}/files?path=${encodeURIComponent(path)}`, {
      headers: { 'Content-Type': 'application/octet-stream' },
      body: content,
    })
  }

  async readFile(path: string): Promise<string> {
    const res = await this.req('GET', `/v1/sandboxes/${this.id}/files?path=${encodeURIComponent(path)}`)
    return res.text()
  }

  /** Upload a local file or directory (dir is tar-streamed). A relative remote is under the sandbox home. */
  async upload(local: string, remote: string): Promise<void> {
    const { statSync, readFileSync: rf } = await import('node:fs')
    if (statSync(local).isDirectory()) {
      // tar the dir locally (uses the system tar), upload, untar via exec.
      const tmpTar = execFileSync('mktemp', ['-t', 'sfupXXXX.tgz']).toString().trim()
      execFileSync('tar', ['-czf', tmpTar, '-C', local, '.'])
      const name = `_sf_up_${Date.now()}.tgz`
      await this.writeFile(name, rf(tmpTar))
      execFileSync('rm', ['-f', tmpTar])
      ;(await this.run(`mkdir -p ${remote} && tar -xzf ${name} -C ${remote} && rm -f ${name}`)).ok
    } else {
      await this.writeFile(remote, rf(local))
    }
  }

  async pause(): Promise<void> { await this.req('POST', `/v1/sandboxes/${this.id}/pause`) }
  async resume(): Promise<void> { await this.req('POST', `/v1/sandboxes/${this.id}/resume`) }
  async setTimeout(seconds: number): Promise<void> {
    await this.req('POST', `/v1/sandboxes/${this.id}/timeout`, {
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seconds }),
    })
  }
  async metrics(): Promise<any> { return (await this.req('GET', `/v1/sandboxes/${this.id}/metrics`)).json() }

  async kill(): Promise<void> {
    try { await this.req('DELETE', `/v1/sandboxes/${this.id}`) } catch { /* best effort */ }
  }
}

/**
 * Build a custom image from a local context (Dockerfile at its root) on the
 * fleet, returning the launchable tag for `Sandbox.create({ image })`.
 */
export async function buildImage(
  contextDir: string,
  tag: string,
  opts: { apiUrl?: string; apiKey?: string } = {},
): Promise<string> {
  const cfg = config()
  const base = (opts.apiUrl || cfg.apiUrl).replace(/\/+$/, '')
  const key = opts.apiKey || cfg.key
  if (!base) throw new Error('no API URL — set PILLDROPS_API_URL to your PillDrops server')
  const { readFileSync } = await import('node:fs')
  const tmpTar = execFileSync('mktemp', ['-t', 'sfbuildXXXX.tgz']).toString().trim()
  execFileSync('tar', ['-czf', tmpTar, '-C', contextDir, '.'])
  const data = readFileSync(tmpTar)
  execFileSync('rm', ['-f', tmpTar])
  const res = await fetch(`${base}/v1/images/build?name=${encodeURIComponent(tag)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: data,
  })
  if (!res.ok) throw new Error(`image build request failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
  const d: any = await res.json()
  if (!d.ok) throw new Error('image build failed:\n' + String(d.log || '').slice(-2000))
  return d.tag as string
}

export async function listTemplates(opts: { apiUrl?: string; apiKey?: string } = {}): Promise<any[]> {
  const cfg = config()
  const base = (opts.apiUrl || cfg.apiUrl).replace(/\/+$/, '')
  const key = opts.apiKey || cfg.key
  const res = await fetch(`${base}/v1/templates`, { headers: key ? { Authorization: `Bearer ${key}` } : {} })
  return res.json() as Promise<any[]>
}

export type WebhookEvent =
  | 'sandbox.created' | 'sandbox.ended' | 'sandbox.paused' | 'sandbox.resumed'
  | 'sandbox.checkpointed' | 'sandbox.forked' | 'sandbox.restarted'
  | 'sandbox.crashed' | 'sandbox.out_of_memory' | 'sandbox.unreachable'

export interface Webhook {
  id: string
  sandbox_id: string
  org_id: string
  url: string
  events: WebhookEvent[]
  enabled: boolean
  consecutive_failures: number
  disabled_reason?: string
  created_at: string
  created_by?: string
  last_at?: string
  last_status?: number
}

export interface CreatedWebhook {
  webhook: Webhook
  /** Signs every delivery. Returned only here. */
  secret: string
  shown_once: boolean
  note: string
}

export interface WebhookTestResult {
  webhook_id: string
  status: number
  ok: boolean
  error?: string
  retryable?: boolean
}

export interface WebhookDelivery {
  id: string
  webhook_id: string
  sandbox_id: string
  org_id: string
  event_type: string
  event_seq: number
  attempts: number
  state: 'pending' | 'sent' | 'failed'
  last_status?: number
  last_error?: string
  next_at?: string
  created_at: string
  updated_at?: string
}

/** The JSON body of one delivery. `id` is the same on every retry. */
export interface WebhookPayload {
  id: string
  type: WebhookEvent
  at: string
  sandbox: { id: string; template?: string }
  data?: Record<string, unknown>
}

type ApiOptions = { apiUrl?: string; apiKey?: string }

async function webhookReq(method: string, path: string, opts: ApiOptions, body?: unknown): Promise<any> {
  const cfg = config()
  const base = (opts.apiUrl || cfg.apiUrl).replace(/\/+$/, '')
  const key = opts.apiKey || cfg.key
  if (!base) throw new Error('no API URL — set PILLDROPS_API_URL to your PillDrops server')
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (res.status === 404) throw new Error(`not found: ${path}`)
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

/** List the org's webhooks. */
export async function listWebhooks(opts: ApiOptions = {}): Promise<Webhook[]> {
  return (await webhookReq('GET', '/v1/webhooks', opts)).webhooks || []
}

/** Register an endpoint for sandbox lifecycle events. Store the returned secret: it is not shown again. */
export async function createWebhook(url: string, events: WebhookEvent[], opts: ApiOptions = {}): Promise<CreatedWebhook> {
  return webhookReq('POST', '/v1/webhooks', opts, { url, events })
}

export async function deleteWebhook(id: string, opts: ApiOptions = {}): Promise<void> {
  await webhookReq('DELETE', `/v1/webhooks/${encodeURIComponent(id)}`, opts)
}

/** Send one signed probe. A failing endpoint resolves with `ok: false`, it does not throw. */
export async function testWebhook(id: string, opts: ApiOptions = {}): Promise<WebhookTestResult> {
  return webhookReq('POST', `/v1/webhooks/${encodeURIComponent(id)}/test`, opts)
}

export async function setWebhookEnabled(id: string, enabled: boolean, opts: ApiOptions = {}): Promise<{ id: string; enabled: boolean }> {
  return webhookReq('POST', `/v1/webhooks/${encodeURIComponent(id)}/toggle`, opts, { enabled })
}

/** Recent deliveries, newest first. */
export async function listWebhookDeliveries(opts: ApiOptions = {}): Promise<WebhookDelivery[]> {
  return (await webhookReq('GET', '/v1/webhooks/deliveries', opts)).deliveries || []
}

/**
 * Check a delivery against the `x-pilldrops-timestamp` and
 * `x-pilldrops-signature` headers. Pass the raw request body, not re-serialized
 * JSON. False for a bad signature or a timestamp more than `toleranceSeconds`
 * from now.
 */
export function verifyWebhookSignature(
  secret: string,
  timestamp: string,
  signature: string,
  body: string | Uint8Array,
  toleranceSeconds = 300,
): boolean {
  if (!/^\d+$/.test(timestamp)) return false
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > toleranceSeconds) return false
  const expected = Buffer.from('sha256=' + createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex'))
  const given = Buffer.from(signature)
  return given.length === expected.length && timingSafeEqual(given, expected)
}
