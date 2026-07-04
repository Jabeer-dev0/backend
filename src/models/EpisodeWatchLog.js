import mongoose from 'mongoose'

const EpisodeWatchLogSchema = new mongoose.Schema(
  {
    episodeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Episode', required: true },
    animeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Anime', required: true },
    viewerId: { type: String, required: true },
    viewerName: { type: String, default: 'Guest' },
    viewCount: { type: Number, default: 1 },
    firstWatchedAt: { type: Date, default: Date.now },
    lastWatchedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
)

EpisodeWatchLogSchema.index({ episodeId: 1, viewerId: 1 }, { unique: true })
EpisodeWatchLogSchema.index({ viewerId: 1, lastWatchedAt: -1 })
EpisodeWatchLogSchema.index({ episodeId: 1, viewCount: -1 })

export default mongoose.model('EpisodeWatchLog', EpisodeWatchLogSchema)
