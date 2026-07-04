import mongoose from 'mongoose'

const UserSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true },
    passwordHash: { type: String, default: '' },
    role: { type: String, enum: ['ADMIN', 'EDITOR', 'USER'], default: 'USER' },
    verified: { type: Boolean, default: false },
    suspended: { type: Boolean, default: false },
    avatar: { type: String, default: '' },
    lastLoginAt: { type: Date, default: null },
    commentCount: { type: Number, default: 0 },
    bookmarkCount: { type: Number, default: 0 },
    likesCount: { type: Number, default: 0 },
    ratingsCount: { type: Number, default: 0 },
  },
  { timestamps: true },
)

export default mongoose.model('User', UserSchema)
