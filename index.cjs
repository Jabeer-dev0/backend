const serverless = require('serverless-http')

let handlerPromise = null

function requestPath(req) {
  return String(req.url || '/').split('?')[0]
}

function sendJson(res, status, data) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(data))
}

function envStatus() {
  return {
    hasMongoUri: Boolean(process.env.MONGODB_URI?.trim()),
    hasJwtSecret: Boolean(process.env.JWT_SECRET?.trim()),
    hasFrontendUrl: Boolean(process.env.FRONTEND_URL?.trim()),
    onVercel: Boolean(process.env.VERCEL),
  }
}

async function checkMongo() {
  const uri = String(process.env.MONGODB_URI || '').trim().replace(/^['"]|['"]$/g, '')
  if (!uri) {
    return { ok: false, db: 'missing MONGODB_URI', hint: 'Vercel → Environment Variables → MONGODB_URI' }
  }

  try {
    const mongoose = require('mongoose')
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 6000,
        connectTimeoutMS: 6000,
        maxPoolSize: 1,
        family: 4,
        bufferCommands: false,
      })
    }
    return { ok: true, db: 'connected' }
  } catch (err) {
    return {
      ok: false,
      db: 'disconnected',
      message: err.message,
      hint: 'MongoDB Atlas → Network Access → Allow 0.0.0.0/0',
    }
  }
}

async function loadHandler() {
  if (!handlerPromise) {
    handlerPromise = import('./src/app.js')
      .then(({ default: app }) => serverless(app))
      .catch((err) => {
        handlerPromise = null
        throw err
      })
  }
  return handlerPromise
}

module.exports = (req, res) => {
  const path = requestPath(req)

  if (path === '/favicon.ico' || path === '/favicon.png') {
    res.statusCode = 204
    res.end()
    return undefined
  }

  if (path === '/') {
    sendJson(res, 200, { ok: true, service: 'AniKura API', env: envStatus() })
    return undefined
  }

  if (path === '/health') {
    return checkMongo().then((result) => {
      sendJson(res, result.ok ? 200 : 503, { ...result, env: envStatus() })
    })
  }

  return loadHandler()
    .then((handler) => handler(req, res))
    .catch((err) => {
      sendJson(res, 500, {
        message: err.message || 'Server failed to start',
        env: envStatus(),
      })
    })
}
