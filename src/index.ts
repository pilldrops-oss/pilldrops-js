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

  /** Write file content (path is relative to the /workspace root). */
  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    await this.req('POST', `/v1/sandboxes/${this.id}/files?path=${encodeURIComponent(path.replace(/^\/+/, ''))}`, {
      headers: { 'Content-Type': 'application/octet-stream' },
      body: content,
    })
  }

  async readFile(path: string): Promise<string> {
    const res = await this.req('GET', `/v1/sandboxes/${this.id}/files?path=${encodeURIComponent(path.replace(/^\/+/, ''))}`)
    return res.text()
  }

  /** Upload a local file or directory (dir is tar-streamed) into the workspace. */
  async upload(local: string, remote: string): Promise<void> {
    const { statSync, readFileSync: rf } = await import('node:fs')
    remote = remote.replace(/^\/+/, '')
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
