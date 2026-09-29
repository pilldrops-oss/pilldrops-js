# PillDrops JavaScript / TypeScript SDK

The Node.js client for [PillDrops](https://github.com/pilldrops-oss/pilldrops),
a self-hosted engine that runs untrusted code in isolated microVMs. Create a
sandbox, run commands and code in it, move files, start a server and get its
preview URL, pause and resume it.

```bash
npm install @pilldrops/sdk          # Node 18+, ES modules
```

## Point it at your server

```bash
export PILLDROPS_API_URL=http://localhost:8080          # your PillDrops server
export PILLDROPS_API_KEY=$(cat /var/lib/sandboxd/bootstrap.key)
```

Settings resolve from the options you pass, then `PILLDROPS_API_URL` /
`PILLDROPS_API_KEY` (`E2B_*`, `SANDFORGE_*` and `SANDBOX_*` are read as
fallbacks, so code written for the E2B SDK runs unchanged), then
`~/.sandforge/config.json`. There is no built-in server: set one.

## Use it

```ts
import { Sandbox } from '@pilldrops/sdk'

const sb = await Sandbox.create({ template: 'python-3.11' })
try {
  console.log((await sb.run("python3 -c 'print(6*7)'")).stdout)   // 42
  await sb.writeFile('/app/main.py', "print('hello')")
  console.log((await sb.run('python3 main.py', '/app')).stdout)    // hello
  await sb.pause()
  await sb.resume()                                                // same memory, same processes
} finally {
  await sb.kill()
}

// A server, reachable at a preview URL
const app = await Sandbox.create({ template: 'node-20', start: 'npm start', ports: [3000] })
console.log(app.url, app.host(3000))
```

| | |
|---|---|
| `Sandbox.create({ template, image, start, ports, env, vcpu, memMb, storageMb, timeout })` | a new sandbox |
| `Sandbox.connect(id)` · `Sandbox.list()` | an existing one · all of them |
| `sb.run(cmd, cwd?, timeout?)` · `sb.runCode(code, lang)` | `{ stdout, stderr, exitCode, truncated, ok }` |
| `sb.writeFile` · `sb.readFile` · `sb.upload(localDir, remoteDir)` | files and directories |
| `sb.url` · `sb.host(port)` | preview URLs |
| `sb.pause()` · `sb.resume()` · `sb.setTimeout(s)` · `sb.kill()` | lifecycle |
| `sb.metrics()` | resource use |
| `buildImage(contextDir, tag)` | build a custom image from a Dockerfile; launch it with `Sandbox.create({ image })` |

## Build and test

```bash
npm ci && npm run build && npm test
```

## License

[MIT](LICENSE).
