import mongoose from 'mongoose'

let connectPromise = null

export function normalizeMongoUri(raw = '') {
  let uri = String(raw).trim().replace(/^['"]|['"]$/g, '')
  if (!uri) return uri

  if (/\.mongodb\.net\/?(\?|$)/.test(uri) && !/\.mongodb\.net\/[^/?]+/.test(uri)) {
    uri = uri.replace(/\.mongodb\.net\/?/, '.mongodb.net/anikura')
  }

  return uri
}

export function mongoOptions() {
  return {
    serverSelectionTimeoutMS: 6000,
    connectTimeoutMS: 6000,
    maxPoolSize: process.env.VERCEL ? 1 : 10,
    bufferCommands: false,
    family: 4,
  }
}

export async function connectMongo() {
  if (mongoose.connection.readyState === 1) return mongoose.connection

  const uri = normalizeMongoUri(process.env.MONGODB_URI)
  if (!uri) {
    throw new Error('Missing MONGODB_URI in environment')
  }

  if (!connectPromise) {
    connectPromise = mongoose.connect(uri, mongoOptions()).then(() => {
      console.log('MongoDB connected')
      return mongoose.connection
    }).catch((err) => {
      connectPromise = null
      throw err
    })
  }

  return connectPromise
}

export function mongoHealthHint(message = '') {
  if (/Missing MONGODB_URI/i.test(message)) {
    return 'Vercel → Settings → Environment Variables → add MONGODB_URI (same as local .env)'
  }
  if (/Could not connect|Server selection timed out|ENOTFOUND|authentication failed/i.test(message)) {
    return 'MongoDB Atlas → Network Access → Add IP → Allow Access from Anywhere (0.0.0.0/0). Also verify username/password in MONGODB_URI.'
  }
  return null
}
