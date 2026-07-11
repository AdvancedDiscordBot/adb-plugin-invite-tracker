const { Schema } = require("mongoose");

// Per-user invite stats
module.exports.InviteStatsSchema = new Schema({
	guildId: { type: String, required: true, index: true },
	userId: { type: String, required: true, index: true },
	totalInvites: { type: Number, default: 0 },
	regularInvites: { type: Number, default: 0 },
	leaveInvites: { type: Number, default: 0 }, // people who joined via them then left
	fakeInvites: { type: Number, default: 0 }, // suspected fake/alt accounts
	bonusInvites: { type: Number, default: 0 }, // manually added via /invites add
});

module.exports.InviteStatsSchema.index({ guildId: 1, userId: 1 }, { unique: true });

// Tracked invite codes
module.exports.InviteCodeSchema = new Schema({
	guildId: { type: String, required: true, index: true },
	code: { type: String, required: true }, // the invite code string
	creatorId: { type: String, required: true }, // who created it
	uses: { type: Number, default: 0 },
	maxUses: { type: Number, default: 0 },
	temporary: { type: Boolean, default: false },
	expiresAt: { type: Date, default: null },
	createdAt: { type: Date, default: Date.now },
});

module.exports.InviteCodeSchema.index({ guildId: 1, code: 1 }, { unique: true });

// Tracked joins for leave deduction
module.exports.JoinLogSchema = new Schema({
	guildId: { type: String, required: true, index: true },
	userId: { type: String, required: true }, // the person who joined
	inviterId: { type: String, required: true }, // who invited them
	inviteCode: { type: String, required: true },
	joinedAt: { type: Date, default: Date.now },
});

module.exports.JoinLogSchema.index({ guildId: 1, userId: 1 }, { unique: true });
