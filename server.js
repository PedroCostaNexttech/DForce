import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const distDir = join(__dirname, 'dist')
const port = Number(process.env.PORT || 10000)
const n8nBaseUrl = normalizeN8nUrl(process.env.N8N_BASE_URL || process.env.VITE_N8N_BASE_URL || '')
const webhookUrls = {
  'sorteio-champions': process.env.N8N_WEBHOOK_CHAMPIONS,
  'sorteio-grupos': process.env.N8N_WEBHOOK_GRUPOS,
  'sorteio-liga': process.env.N8N_WEBHOOK_LIGA,
  'sorteio-qualificacao': process.env.N8N_WEBHOOK_QUALIFICACAO,
  'sorteio-eliminatorias': process.env.N8N_WEBHOOK_ELIMINATORIAS,
  'sorteio-taca': process.env.N8N_WEBHOOK_TACA,
}
const drawFormatToWebhook = {
  champions: 'sorteio-champions',
  grupos: 'sorteio-grupos',
  liga: 'sorteio-liga',
  qualificacao: 'sorteio-qualificacao',
  eliminatorias: 'sorteio-eliminatorias',
  taca: 'sorteio-taca',
}

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

function sendJson(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(payload))
}

function getForwardHeaders(request, targetUrl) {
  const headers = new Headers(request.headers)
  const target = new URL(targetUrl)

  headers.set('host', target.host)
  headers.delete('connection')
  headers.delete('content-length')
  headers.delete('accept-encoding')

  return headers
}

function getQueryString(url) {
  return url.includes('?') ? `?${url.split('?').slice(1).join('?')}` : ''
}

function resolveWebhookTarget(webhookKey, requestUrl = '') {
  const directWebhookUrl = webhookUrls[webhookKey]?.trim()

  if (!n8nBaseUrl && !directWebhookUrl) {
    return null
  }

  return directWebhookUrl
    ? `${directWebhookUrl.replace(/\/+$/, '')}${getQueryString(requestUrl)}`
    : `${n8nBaseUrl}/${webhookKey}${getQueryString(requestUrl)}`
}

function getStaticPath(urlPath) {
  const decodedPath = decodeURIComponent(urlPath.split('?')[0])
  const cleanPath = normalize(decodedPath).replace(/^(\.\.[/\\])+/, '')
  const relativePath = cleanPath === '/' ? '/index.html' : cleanPath
  return join(distDir, relativePath)
}

async function proxyWebhook(request, response) {
  const targetPath = request.url.replace(/^\/webhook\/?/, '').replace(/^\/+/, '')
  const webhookKey = targetPath.split(/[/?#]/)[0]
  const targetUrl = resolveWebhookTarget(webhookKey, request.url)

  if (!targetUrl) {
    sendText(response, 502, 'N8N_BASE_URL or a matching N8N_WEBHOOK_* variable is not configured on this Render service.')
    return
  }

  console.log(`[webhook-proxy] ${request.method} ${request.url} -> ${targetUrl}`)

  if (request.url.includes('__debug=1')) {
    sendJson(response, 200, {
      requestUrl: request.url,
      targetPath,
      webhookKey,
      usingDirectWebhookUrl: !!webhookUrls[webhookKey]?.trim(),
      targetUrl,
      configuredBaseUrl: n8nBaseUrl || null,
    })
    return
  }

  try {
    const upstream = await fetch(targetUrl, {
      method: request.method,
      headers: getForwardHeaders(request, targetUrl),
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request,
      duplex: 'half',
    })

    response.writeHead(upstream.status, {
      ...Object.fromEntries(upstream.headers.entries()),
      'x-dforce-target-url': targetUrl,
    })
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

async function proxyDrawRequest(request, response) {
  const rawFormat = request.url.replace(/^\/api\/sorteio\/?/, '').split(/[/?#]/)[0]
  const format = decodeURIComponent(rawFormat || '').trim().toLowerCase()
  const webhookKey = drawFormatToWebhook[format]

  if (!webhookKey) {
    sendJson(response, 400, {
      success: false,
      error: `Formato de sorteio inválido: ${format || '(vazio)'}.`,
    })
    return
  }

  const targetUrl = resolveWebhookTarget(webhookKey, request.url)

  if (!targetUrl) {
    sendJson(response, 502, {
      success: false,
      error: `Webhook n8n não configurado para o formato "${format}".`,
      expectedEnv: `N8N_WEBHOOK_${format.toUpperCase()}`,
    })
    return
  }

  console.log(`[draw-api] ${request.method} /api/sorteio/${format} -> ${targetUrl}`)

  if (request.url.includes('__debug=1')) {
    sendJson(response, 200, {
      format,
      webhookKey,
      targetUrl,
      usingDirectWebhookUrl: !!webhookUrls[webhookKey]?.trim(),
      configuredBaseUrl: n8nBaseUrl || null,
    })
    return
  }

  try {
    const upstream = await fetch(targetUrl, {
      method: request.method,
      headers: getForwardHeaders(request, targetUrl),
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request,
      duplex: 'half',
    })

    response.writeHead(upstream.status, {
      ...Object.fromEntries(upstream.headers.entries()),
      'x-dforce-target-url': targetUrl,
    })

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
    sendJson(response, 502, {
      success: false,
      error: `Não foi possível contactar o webhook n8n: ${error.message}`,
      targetUrl,
    })
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
  if (request.url.startsWith('/api/sorteio/')) {
    proxyDrawRequest(request, response)
    return
  }

  if (request.url.startsWith('/webhook')) {
    proxyWebhook(request, response)
    return
  }

  serveStatic(request, response)
})

server.listen(port, '0.0.0.0', () => {
  console.log(`DForce listening on ${port}`)
})
