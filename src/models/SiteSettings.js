import mongoose from 'mongoose'

const SiteSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'global', unique: true },
    siteName: { type: String, default: 'AniKura' },
    siteLogo: { type: String, default: '' },
    favicon: { type: String, default: '' },
    footerText: { type: String, default: '' },
    contactEmail: { type: String, default: '' },
    socialLinks: {
      twitter: { type: String, default: '' },
      discord: { type: String, default: '' },
      youtube: { type: String, default: '' },
    },
    defaultMetaTitle: { type: String, default: '' },
    defaultMetaDescription: { type: String, default: '' },
    heroTitle: { type: String, default: 'Watch Anime on AniKura' },
    heroSubtitle: { type: String, default: 'Discover trending series, fresh episodes, and upcoming releases — all in one place.' },
    featuredAnimeIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Anime' }],
    maintenanceMode: { type: Boolean, default: false },
    commentsEnabled: { type: Boolean, default: true },
    ratingsEnabled: { type: Boolean, default: true },
    registrationEnabled: { type: Boolean, default: true },
    emailVerificationRequired: { type: Boolean, default: false },
    episodeCommentsEnabled: { type: Boolean, default: true },
  },
  { timestamps: true },
)

export default mongoose.model('SiteSettings', SiteSettingsSchema)
