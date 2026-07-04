import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'

import publicRoutes from './routes/public.js'
import adminRoutes from './routes/admin.js'
import dashboardRoutes from './routes/dashboard.js'
import animesRoutes from './routes/animes.js'
import episodesRoutes from './routes/episodes.js'
import genresRoutes from './routes/genres.js'
import tagsRoutes from './routes/tags.js'
import commentsRoutes from './routes/comments.js'
import usersRoutes from './routes/users.js'
import analyticsRoutes from './routes/analytics.js'
import mediaRoutes from './routes/media.js'
import uploadsRoutes from './routes/uploads.js'
import settingsRoutes from './routes/settings.js'
import { connectMongo, mongoHealthHint, normalizeMongoUri } from './utils/mongo.js'

dotenv.config()

const app = express()

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

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'AniKura API' })
})

app.get('/favicon.ico', (req, res) => res.status(204).end())
app.get('/favicon.png', (req, res) => res.status(204).end())

app.get('/health', async (req, res) => {
  const uri = normalizeMongoUri(process.env.MONGODB_URI)
  if (!uri) {
    return res.status(503).json({
      ok: false,
      db: 'missing MONGODB_URI',
      hint: mongoHealthHint('Missing MONGODB_URI'),
    })
  }

  try {
    await connectMongo()
    return res.json({ ok: true, db: 'connected' })
  } catch (err) {
    return res.status(503).json({
      ok: false,
      db: 'disconnected',
      message: err.message,
      hint: mongoHealthHint(err.message),
    })
  }
})

app.use(async (req, res, next) => {
  try {
    await connectMongo()
    next()
  } catch (err) {
    console.error('MongoDB connection failed:', err.message)
    res.status(503).json({
      message: 'Database unavailable',
      hint: mongoHealthHint(err.message),
    })
  }
})

app.use('/api/public', publicRoutes)
app.use('/api/admin', adminRoutes)
app.use('/api/dashboard', dashboardRoutes)
app.use('/api/animes', animesRoutes)
app.use('/api/episodes', episodesRoutes)
app.use('/api/genres', genresRoutes)
app.use('/api/tags', tagsRoutes)
app.use('/api/comments', commentsRoutes)
app.use('/api/users', usersRoutes)
app.use('/api/analytics', analyticsRoutes)
app.use('/api/media', mediaRoutes)
app.use('/api/uploads', uploadsRoutes)
app.use('/api/settings', settingsRoutes)

export default app
