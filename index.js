const { Events } = require("discord.js");
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
	const queues = new Map();
	const baselines = new Set();
	const pendingCredits = new Map();
	let active = true;

	async function queueGuild(guildId, action) {
		const next = (queues.get(guildId) || Promise.resolve()).catch(() => {}).then(() => active ? action() : undefined);
		queues.set(guildId, next);
		try {
			return await next;
		} catch (error) {
			baselines.delete(guildId);
			pendingCredits.delete(guildId);
			throw error;
		} finally {
			if (queues.get(guildId) === next) queues.delete(guildId);
		}
	}

	async function getConfig(guildId) {
		const config = await ctx.db.getPluginConfig(guildId, "adb-plugin-invite-tracker");
		const data = config?.data || {};
		if (data.enabled === false) {
			baselines.delete(guildId);
			pendingCredits.delete(guildId);
		}
		return data;
	}

	async function cacheInvites(guildId, invites) {
		for (const invite of invites.values()) {
			await InviteCodeModel.findOneAndUpdate(
				{ guildId, code: invite.code },
				{
					creatorId: invite.inviter?.id || "unknown",
					uses: invite.uses ?? 0,
					maxUses: invite.maxUses || 0,
					temporary: invite.temporary || false,
					expiresAt: invite.expiresAt || null,
				},
				{ upsert: true },
			);
		}
		await InviteCodeModel.deleteMany({ guildId, code: { $nin: [...invites.keys()] } });
	}

	function syncGuild(guild) {
		return queueGuild(guild.id, async () => {
			if ((await getConfig(guild.id)).enabled === false) return null;
			const invites = await guild.invites.fetch();
			await cacheInvites(guild.id, invites);
			pendingCredits.delete(guild.id);
			baselines.add(guild.id);
			return invites.size;
		});
	}

	for (const command of [
		createInvitesCommand(InviteStatsModel, JoinLogModel, ctx.db),
		createInvitesAdminCommand(InviteStatsModel, InviteCodeModel, JoinLogModel, ctx.db, syncGuild),
	]) {
		const execute = command.execute;
		command.execute = async (interaction) => {
			if (!interaction.guildId) {
				return interaction.reply({ content: "Invite tracking is disabled in this server.", ephemeral: true });
			}
			await interaction.deferReply({ ephemeral: true });
			if ((await getConfig(interaction.guildId)).enabled === false) {
				return interaction.editReply({ content: "Invite tracking is disabled in this server." });
			}
			return execute(interaction);
		};
		ctx.registerCommand(command);
	}

	// Track invite code creation / deletion
	ctx.registerEvent("inviteCreate", async (invite) => {
		if (!invite.guild?.id) return;
		try {
			await queueGuild(invite.guild.id, async () => {
				if ((await getConfig(invite.guild.id)).enabled === false) return;
				await InviteCodeModel.findOneAndUpdate(
					{ guildId: invite.guild.id, code: invite.code },
					{
						creatorId: invite.inviter?.id || "unknown",
						uses: invite.uses ?? 0,
						maxUses: invite.maxUses || 0,
						temporary: invite.temporary || false,
						expiresAt: invite.expiresAt || null,
					},
					{ upsert: true }
				);
			});
		} catch (err) {
			ctx.logger.error("inviteCreate handler error", err);
		}
	});

	ctx.registerEvent("inviteDelete", async (invite) => {
		if (!invite.guild?.id) return;
		try {
			await queueGuild(invite.guild.id, async () => {
				if ((await getConfig(invite.guild.id)).enabled === false) return;
				await InviteCodeModel.deleteOne({ guildId: invite.guild.id, code: invite.code });
				pendingCredits.get(invite.guild.id)?.delete(invite.code);
			});
		} catch (err) {
			ctx.logger.error("inviteDelete handler error", err);
		}
	});

	async function syncAll() {
		for (const guild of ctx.client.guilds.cache.values()) {
			await syncGuild(guild).catch((err) => ctx.logger.error(`Invite cache failed for ${guild.id}`, err));
		}
	}
	ctx.registerEvent(Events.ClientReady, syncAll);
	ctx.registerEvent("guildCreate", (guild) => syncGuild(guild).catch((err) => ctx.logger.error("guildCreate invite cache error", err)));
	ctx.registerEvent("guildDelete", (guild) => queueGuild(guild.id, async () => {
		baselines.delete(guild.id);
		pendingCredits.delete(guild.id);
		await InviteCodeModel.deleteMany({ guildId: guild.id });
	}).catch((err) => ctx.logger.error("guildDelete invite cache error", err)));
	ctx.hooks.on("onPluginUnload", async ({ pluginName }) => {
		if (pluginName !== "adb-plugin-invite-tracker") return;
		active = false;
		await Promise.allSettled(queues.values());
		baselines.clear();
		pendingCredits.clear();
	});

	// On member join: detect which invite code was used
	ctx.registerEvent("guildMemberAdd", async (member) => {
		try {
			const guild = member.guild;
			await queueGuild(guild.id, async () => {
				const configData = await getConfig(guild.id);
				if (configData.enabled === false) return;
				if (await JoinLogModel.findOne({ guildId: guild.id, userId: member.id })) return;
				const now = await guild.invites.fetch();
				const previous = new Map((await InviteCodeModel.find({ guildId: guild.id })).map((invite) => [invite.code, invite]));
				const credits = pendingCredits.get(guild.id) || new Map();
				const timestamp = Date.now();
				for (const [code, credit] of credits) {
					if (credit.expiresAt <= timestamp || !now.has(code)) credits.delete(code);
				}
				if (baselines.has(guild.id)) {
					for (const [code, invite] of now) {
						const cached = previous.get(code);
						if (!cached || !Number.isInteger(invite.uses) || invite.uses <= cached.uses) continue;
						const creatorId = invite.inviter?.id || cached.creatorId;
						credits.set(code, {
							code, creatorId,
							remaining: (credits.get(code)?.remaining || 0) + invite.uses - cached.uses,
							expiresAt: timestamp + 10000,
						});
					}
				} else {
					credits.clear();
				}

				await cacheInvites(guild.id, now);
				baselines.add(guild.id);
				// A snapshot can contain several queued joins, but different changed
				// codes cannot be assigned to individual members with certainty.
				if (credits.size > 1) credits.clear();
				const credit = credits.values().next().value;
				if (credit && --credit.remaining === 0) credits.delete(credit.code);
				if (credits.size) pendingCredits.set(guild.id, credits);
				else pendingCredits.delete(guild.id);
				const matchedCreator = credit?.creatorId && credit.creatorId !== "unknown" ? credit.creatorId : null;

				// Do not create a deductible join if its credit write fails.
				const stats = matchedCreator ? await InviteStatsModel.findOneAndUpdate(
					{ guildId: guild.id, userId: matchedCreator },
					{ $inc: { regularInvites: 1, totalInvites: 1 } },
					{ upsert: true, new: true }
				) : null;
				await JoinLogModel.create({
					guildId: guild.id,
					userId: member.id,
					inviterId: matchedCreator,
					inviteCode: credit?.code || null,
					joinedAt: new Date(member.joinedTimestamp || timestamp),
				});
				if (!stats) return;

				// Check milestone roles
				if (typeof configData.bonusRoles === "string" && configData.bonusRoles) {
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
			});
		} catch (err) {
			ctx.logger.error("guildMemberAdd invite tracker error", err);
		}
	});

	// On member leave: deduct invite credit
	ctx.registerEvent("guildMemberRemove", async (member) => {
		try {
			await queueGuild(member.guild.id, async () => {
				const config = await getConfig(member.guild.id);
				const joinLog = await JoinLogModel.findOne({
					guildId: member.guild.id,
					userId: member.id,
				});
				if (!joinLog) return;
				await JoinLogModel.deleteOne({ _id: joinLog._id });
				if (config.enabled === false || config.trackLeaves === false || !joinLog.inviterId) return;

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
			});
		} catch (err) {
			ctx.logger.error("guildMemberRemove invite tracker error", err);
		}
	});

	if (ctx.client.isReady?.()) await syncAll();
	ctx.logger.info("Invite Tracker plugin loaded");
}

module.exports = { load };
