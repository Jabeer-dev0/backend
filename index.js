import express from 'express'
import cors from 'cors'
import mongoose from 'mongoose'
import dotenv from 'dotenv'

dotenv.config()

const app = express()

const PORT = process.env.PORT || 5000
const MONGODB_URI = process.env.MONGODB_URI

const allowedOrigins = [
  'http://localhost:5173',
  ...(process.env.FRONTEND_URL || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
]

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}))
app.use(express.json({ limit: '25mb' }))
app.get('/',(req,res)=>{
    res.send("server running")
})

app.get('/health', (req, res) => {
  const dbReady = mongoose.connection.readyState === 1
  res.status(dbReady ? 200 : 503).json({ ok: dbReady, db: dbReady ? 'connected' : 'disconnected' })
})

async function connectMongo(retries = 0) {
  if (!MONGODB_URI) {
    throw new Error('Missing MONGODB_URI in environment')
  }

  try {
    await mongoose.connect(MONGODB_URI)
    console.log('MongoDB connected')
  } catch (err) {
    const waitMs = Math.min(30000, 5000 * (retries + 1))
    console.error(`MongoDB connection failed (attempt ${retries + 1}): ${err.message}`)
    console.error('Atlas pe apna IP whitelist karo: https://cloud.mongodb.com → Network Access → Add IP')
    await new Promise((r) => setTimeout(r, waitMs))
    return connectMongo(retries + 1)
  }
}
 const server = app.listen(PORT, () => {
    console.log(`server running on http://localhost:${PORT}`)
  })

async function start() {
  await connectMongo()

  app.use('/api/public', (await import('./src/routes/public.js')).default)
  app.use('/api/admin', (await import('./src/routes/admin.js')).default)
  app.use('/api/dashboard', (await import('./src/routes/dashboard.js')).default)
  app.use('/api/animes', (await import('./src/routes/animes.js')).default)
  app.use('/api/episodes', (await import('./src/routes/episodes.js')).default)
  app.use('/api/genres', (await import('./src/routes/genres.js')).default)
  app.use('/api/tags', (await import('./src/routes/tags.js')).default)
  app.use('/api/comments', (await import('./src/routes/comments.js')).default)
  app.use('/api/users', (await import('./src/routes/users.js')).default)
  app.use('/api/analytics', (await import('./src/routes/analytics.js')).default)
  app.use('/api/media', (await import('./src/routes/media.js')).default)
  app.use('/api/uploads', (await import('./src/routes/uploads.js')).default)
  app.use('/api/settings', (await import('./src/routes/settings.js')).default)

 
  server.requestTimeout = 0
  server.headersTimeout = 0

  const { startEpisodeScheduler } = await import('./src/utils/episodeScheduler.js')
  startEpisodeScheduler()
}

start().catch((err) => {
  console.error(err)
  process.exit(1)
})
export {server}