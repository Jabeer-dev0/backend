import mongoose from 'mongoose'

const AdminUserSchema = new mongoose.Schema(
  {
    username: { type: String, default: '' },
    googleSub: { type: String, unique: true, sparse: true },
    email: { type: String, unique: true, sparse: true },
    name: { type: String, default: 'Admin' },
    avatar: { type: String, default: '' },
    roles: { type: [String], default: ['ADMIN'] },
    twoFactorEnabled: { type: Boolean, default: false },
    twoFactorSecret: { type: String, default: '' },
    resetToken: { type: String, default: '' },
    resetTokenExpiry: { type: Date, default: null },
  },
  { timestamps: true },
)

export default mongoose.model('AdminUser', AdminUserSchema)
