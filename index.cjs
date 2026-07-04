const serverless = require('serverless-http')

let handlerPromise = null

function requestPath(req) {
  return String(req.url || '/').split('?')[0]
}

async function quickHealth(res) {
  const uri = String(process.env.MONGODB_URI || '').trim().replace(/^['"]|['"]$/g, '')

  if (!uri) {
    res.statusCode = 503
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({
      ok: false,
      db: 'missing MONGODB_URI',
      hint: 'Vercel → Settings → Environment Variables → add MONGODB_URI',
    }))
    return
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

    res.statusCode = 200
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ok: true, db: 'connected' }))
  } catch (err) {
    res.statusCode = 503
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({
      ok: false,
      db: 'disconnected',
      message: err.message,
      hint: 'MongoDB Atlas → Network Access → Allow 0.0.0.0/0',
    }))
  }
}

async function getHandler() {
  if (!handlerPromise) {
    handlerPromise = import('./src/app.js').then(({ default: app }) => serverless(app))
  }
  return handlerPromise
}

module.exports = async (req, res) => {
  const path = requestPath(req)

  if (path === '/favicon.ico' || path === '/favicon.png') {
    res.statusCode = 204
    res.end()
    return
  }

  if (path === '/') {
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ok: true, service: 'AniKura API' }))
    return
  }

  if (path === '/health') {
    return quickHealth(res)
  }

  const handler = await getHandler()
  return handler(req, res)
}
