const {
	createInvitesCommand,
	createInvitesAdminCommand,
} = require("./commands/invites");
const {
	InviteStatsSchema,
	InviteCodeSchema,
	JoinLogSchema,
} = require("./models/invite");

async function load(ctx) {
	const InviteStatsModel = ctx.defineModel("inviteStats", InviteStatsSchema);
	const InviteCodeModel = ctx.defineModel("inviteCode", InviteCodeSchema);
	const JoinLogModel = ctx.defineModel("joinLog", JoinLogSchema);

	ctx.registerCommand(createInvitesCommand(InviteStatsModel, JoinLogModel, ctx.db));
	ctx.registerCommand(createInvitesAdminCommand(InviteStatsModel, InviteCodeModel, JoinLogModel, ctx.db));

	// Track invite code creation / deletion
	ctx.registerEvent("inviteCreate", async (invite) => {
		try {
			await InviteCodeModel.findOneAndUpdate(
				{ guildId: invite.guild.id, code: invite.code },
				{
					creatorId: invite.inviter?.id || "unknown",
					uses: invite.uses,
					maxUses: invite.maxUses || 0,
					temporary: invite.temporary || false,
					expiresAt: invite.expiresAt || null,
				},
				{ upsert: true }
			);
		} catch (err) {
			ctx.logger.error("inviteCreate handler error", err);
		}
	});

	ctx.registerEvent("inviteDelete", async (invite) => {
		try {
			await InviteCodeModel.deleteOne({ guildId: invite.guild.id, code: invite.code });
		} catch (err) {
			ctx.logger.error("inviteDelete handler error", err);
		}
	});

	// On guild join: cache all existing invites
	ctx.registerEvent("ready", async (client) => {
		// Rate-limit: cache invites for all guilds on startup
		for (const guild of client.guilds.cache.values()) {
			try {
				const invites = await guild.invites.fetch().catch(() => null);
				if (!invites) continue;
				for (const invite of invites.values()) {
					await InviteCodeModel.findOneAndUpdate(
						{ guildId: guild.id, code: invite.code },
						{
							creatorId: invite.inviter?.id || "unknown",
							uses: invite.uses,
							maxUses: invite.maxUses || 0,
							temporary: invite.temporary || false,
							expiresAt: invite.expiresAt || null,
						},
						{ upsert: true }
					);
				}
			} catch {
				// skip guilds with no invite permissions
			}
		}
		ctx.logger.info("Invite cache populated on ready");
	});

	// On member join: detect which invite code was used
	ctx.registerEvent("guildMemberAdd", async (member) => {
		try {
			const guild = member.guild;
			const now = await guild.invites.fetch().catch(() => null);
			if (!now) return;
			if (now.size === 0) return;

			// The invite that got a use bump is our match
			let matchedCode = null;
			let matchedCreator = null;

			for (const [code, invite] of now) {
				const cached = await InviteCodeModel.findOne({
					guildId: guild.id,
					code,
				});
				const prevUses = cached?.uses ?? invite.uses;
				if (invite.uses > prevUses) {
					matchedCode = code;
					matchedCreator = invite.inviter?.id || cached?.creatorId;
					break;
				}
			}

			if (!matchedCode) return;

			// Update invite code cache
			await InviteCodeModel.findOneAndUpdate(
				{ guildId: guild.id, code: matchedCode },
				{ uses: now.get(matchedCode)?.uses ?? 0 }
			);

			// Update inviter stats
			const stats = await InviteStatsModel.findOneAndUpdate(
				{ guildId: guild.id, userId: matchedCreator },
				{ $inc: { regularInvites: 1, totalInvites: 1 } },
				{ upsert: true, new: true }
			);

			// Log the join
			await JoinLogModel.findOneAndUpdate(
				{ guildId: guild.id, userId: member.id },
				{
					inviterId: matchedCreator,
					inviteCode: matchedCode,
					joinedAt: new Date(),
				},
				{ upsert: true }
			);

			// Check milestone roles
			const pluginConfig = await ctx.db.getPluginConfig(guild.id, "adb-plugin-invite-tracker").catch(() => ({ data: {} }));
			const configData = pluginConfig?.data || {};
			if (configData.bonusRoles) {
				const roleMap = {};
				configData.bonusRoles.split(",").forEach((entry) => {
					const [roleId, count] = entry.split(":").map((s) => s.trim());
					if (roleId && count) roleMap[parseInt(count)] = roleId;
				});
				const sortedMilestones = Object.keys(roleMap)
					.map(Number)
					.sort((a, b) => b - a);
				for (const milestone of sortedMilestones) {
					if (stats.totalInvites >= milestone) {
						try {
							const role = await guild.roles.fetch(roleMap[milestone]);
							const inviterMember = await guild.members.fetch(matchedCreator).catch(() => null);
							if (role && inviterMember && !inviterMember.roles.cache.has(role.id)) {
								await inviterMember.roles.add(role);
							}
						} catch {}
						break;
					}
				}
			}
		} catch (err) {
			ctx.logger.error("guildMemberAdd invite tracker error", err);
		}
	});

	// On member leave: deduct invite credit
	ctx.registerEvent("guildMemberRemove", async (member) => {
		try {
			const joinLog = await JoinLogModel.findOne({
				guildId: member.guild.id,
				userId: member.id,
			});
			if (!joinLog) return;

			await InviteStatsModel.findOneAndUpdate(
				{ guildId: member.guild.id, userId: joinLog.inviterId },
				{
					$inc: {
						leaveInvites: 1,
						totalInvites: -1,
						regularInvites: -1,
					},
				}
			);

			await JoinLogModel.deleteOne({ _id: joinLog._id });
		} catch (err) {
			ctx.logger.error("guildMemberRemove invite tracker error", err);
		}
	});

	ctx.logger.info("Invite Tracker plugin loaded");
}

module.exports = { load };