import app, { connectMongo } from './src/app.js'

const PORT = process.env.PORT || 5000
const isVercel = Boolean(process.env.VERCEL)

async function startLocalServer() {
  await connectMongo()

  const server = app.listen(PORT, () => {
    console.log(`server running on http://localhost:${PORT}`)
  })
  server.requestTimeout = 0
  server.headersTimeout = 0

  const { startEpisodeScheduler } = await import('./src/utils/episodeScheduler.js')
  startEpisodeScheduler()
}

if (!isVercel) {
  startLocalServer().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}

export default app
