import mongoose from 'mongoose'

const EpisodeLikeSchema = new mongoose.Schema(
  {
    episodeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Episode', required: true },
    animeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Anime', required: true },
    viewerId: { type: String, required: true },
    viewerName: { type: String, default: 'Guest' },
  },
  { timestamps: true },
)

EpisodeLikeSchema.index({ episodeId: 1, viewerId: 1 }, { unique: true })

export default mongoose.model('EpisodeLike', EpisodeLikeSchema)
