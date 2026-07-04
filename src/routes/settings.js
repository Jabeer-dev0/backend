import express from 'express'
import SiteSettings from '../models/SiteSettings.js'
import { requireAdmin } from './adminAuth.js'
import { pickDefined } from '../utils/helpers.js'

const router = express.Router()

async function getSettings() {
  let settings = await SiteSettings.findOne({ key: 'global' })
  if (!settings) {
    settings = await SiteSettings.create({ key: 'global' })
  }
  return settings
}

router.get('/', async (req, res) => {
  const settings = await getSettings()
  res.json({ settings })
})

router.patch('/', requireAdmin, async (req, res) => {
  const settings = await SiteSettings.findOneAndUpdate(
    { key: 'global' },
    { $set: pickDefined(req.body || {}) },
    { new: true, upsert: true },
  )
  res.json({ settings })
})

export default router
