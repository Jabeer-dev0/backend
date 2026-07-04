import mongoose from 'mongoose'

const CommentSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    username: { type: String, default: 'Guest' },
    animeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Anime', default: null },
    episodeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Episode', default: null },
    content: { type: String, required: true },
    status: { type: String, enum: ['approved', 'pending', 'hidden'], default: 'approved' },
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Comment', default: null },
  },
  { timestamps: true },
)

export default mongoose.model('Comment', CommentSchema)
