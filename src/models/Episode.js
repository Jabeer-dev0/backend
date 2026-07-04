import mongoose from 'mongoose'

const EpisodeSchema = new mongoose.Schema(
  {
    animeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Anime', required: true },
    episodeNo: { type: Number, required: true },
    title: { type: String, default: '' },
    slug: { type: String, default: '' },
    description: { type: String, default: '' },
    thumbnail: { type: String, default: '' },
    durationMin: { type: Number, default: 24 },
    isFiller: { type: Boolean, default: false },
    embedUrl: { type: String, default: '' },
    videoUrl: { type: String, default: '' },
    externalUrl: { type: String, default: '' },
    video: { type: String, default: '' },
    subtitles: { type: String, default: '' },
    releaseDate: { type: String, default: '' },
    releaseTime: { type: String, default: '' },
    releaseAt: { type: Date, default: null },
    status: { type: String, enum: ['draft', 'scheduled', 'released'], default: 'draft' },
    scheduleMode: { type: String, enum: ['ready', 'upload_later'], default: 'ready' },
    published: { type: Boolean, default: false },
    preview: { type: Boolean, default: false },
    rating: { type: Number, default: 0 },
    views: { type: Number, default: 0 },
    likes: { type: Number, default: 0 },
    commentCount: { type: Number, default: 0 },
  },
  { timestamps: true },
)

EpisodeSchema.index({ animeId: 1, episodeNo: 1 }, { unique: true })
EpisodeSchema.index({ releaseAt: 1, status: 1 })

export default mongoose.model('Episode', EpisodeSchema)
