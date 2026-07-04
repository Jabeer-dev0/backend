import app, { connectMongo } from './src/app.js'

export default function handler(req, res) {
  return app(req, res)
}

const PORT = process.env.PORT || 5000

if (!process.env.VERCEL) {
  connectMongo()
    .then(async () => {
      const server = app.listen(PORT, () => {
        console.log(`server running on http://localhost:${PORT}`)
      })
      server.requestTimeout = 0
      server.headersTimeout = 0

      const { startEpisodeScheduler } = await import('./src/utils/episodeScheduler.js')
      startEpisodeScheduler()
    })
    .catch((err) => {
      console.error(err)
      process.exit(1)
    })
}
