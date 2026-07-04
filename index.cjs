const serverless = require('serverless-http')

let handlerPromise = null

async function getHandler() {
  if (!handlerPromise) {
    handlerPromise = import('./src/app.js').then(({ default: app }) => serverless(app))
  }
  return handlerPromise
}

module.exports = async (req, res) => {
  const handler = await getHandler()
  return handler(req, res)
}
