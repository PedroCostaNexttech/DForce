import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const distDir = join(__dirname, 'dist')
const port = Number(process.env.PORT || 10000)
const n8nBaseUrl = normalizeN8nUrl(process.env.N8N_BASE_URL || process.env.VITE_N8N_BASE_URL || '')

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
}

function normalizeN8nUrl(value) {
  const cleaned = String(value || '').trim().replace(/\/+$/, '')
  if (!cleaned) return ''
  return /\/webhook$/i.test(cleaned) ? cleaned : `${cleaned}/webhook`
}

function sendText(response, status, text) {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  response.end(text)
}

function getStaticPath(urlPath) {
  const decodedPath = decodeURIComponent(urlPath.split('?')[0])
  const cleanPath = normalize(decodedPath).replace(/^(\.\.[/\\])+/, '')
  const relativePath = cleanPath === '/' ? '/index.html' : cleanPath
  return join(distDir, relativePath)
}

async function proxyWebhook(request, response) {
  if (!n8nBaseUrl) {
    sendText(response, 502, 'N8N_BASE_URL is not configured on this Render service.')
    return
  }

  const targetPath = request.url.replace(/^\/webhook\/?/, '')
  const targetUrl = `${n8nBaseUrl}/${targetPath}`

  try {
    const upstream = await fetch(targetUrl, {
      method: request.method,
      headers: request.headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request,
      duplex: 'half',
    })

    response.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()))
    if (upstream.body) {
      await upstream.body.pipeTo(new WritableStream({
        write(chunk) {
          response.write(Buffer.from(chunk))
        },
        close() {
          response.end()
        },
        abort(error) {
          response.destroy(error)
        },
      }))
    } else {
      response.end()
    }
  } catch (error) {
    sendText(response, 502, `Unable to reach n8n: ${error.message}`)
  }
}

function serveStatic(request, response) {
  const staticPath = getStaticPath(request.url)
  const filePath = existsSync(staticPath) && statSync(staticPath).isFile()
    ? staticPath
    : join(distDir, 'index.html')

  const extension = extname(filePath)
  response.writeHead(200, {
    'content-type': contentTypes[extension] || 'application/octet-stream',
    'cache-control': filePath.includes(`${distDir}\\assets`) || filePath.includes(`${distDir}/assets`)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
  })
  createReadStream(filePath).pipe(response)
}

const server = http.createServer((request, response) => {
  if (request.url.startsWith('/webhook')) {
    proxyWebhook(request, response)
    return
  }

  serveStatic(request, response)
})

server.listen(port, '0.0.0.0', () => {
  console.log(`DForce listening on ${port}`)
})
