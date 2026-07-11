const { EmbedBuilder } = require("discord.js");

function createInvitesCommand(InviteStatsModel, JoinLogModel, db) {
	return {
		data: {
			name: "invites",
			description: "Check invites and leaderboard",
			options: [
				{
					name: "me",
					description: "Check your own invite count",
					type: 1,
				},
				{
					name: "user",
					description: "Check another user's invites",
					type: 1,
					options: [
						{
							name: "user",
							type: 6,
							description: "The user to check",
							required: true,
						},
					],
				},
				{
					name: "leaderboard",
					description: "Show the invite leaderboard",
					type: 1,
				},
			],
		},
		async execute(interaction) {
			const sub = interaction.options.getSubcommand();
			const guildId = interaction.guildId;

			if (sub === "me") {
				const stats = await InviteStatsModel.findOne({ guildId, userId: interaction.user.id });
				if (!stats || stats.totalInvites === 0) {
					return interaction.reply({ content: "You haven't invited anyone yet.", ephemeral: true });
				}
				return interaction.reply({ embeds: [makeStatsEmbed(interaction.user, stats)], ephemeral: true });
			}

			if (sub === "user") {
				const target = interaction.options.getUser("user");
				const stats = await InviteStatsModel.findOne({ guildId, userId: target.id });
				if (!stats || stats.totalInvites === 0) {
					return interaction.reply({ content: `${target.tag} hasn't invited anyone yet.`, ephemeral: true });
				}
				return interaction.reply({ embeds: [makeStatsEmbed(target, stats)], ephemeral: true });
			}

			if (sub === "leaderboard") {
				const top = await InviteStatsModel.find({ guildId })
					.sort({ totalInvites: -1 })
					.limit(10);

				if (top.length === 0) {
					return interaction.reply({ content: "No invites yet.", ephemeral: true });
				}

				const lines = [];
				const medals = ["🥇", "🥈", "🥉"];
				for (let i = 0; i < top.length; i++) {
					const prefix = medals[i] || `${i + 1}.`;
					const user = await interaction.client.users.fetch(top[i].userId).catch(() => null);
					const name = user?.tag || "Unknown User";
					lines.push(`${prefix} **${name}** — ${top[i].totalInvites} invite(s)`);
				}

				const embed = new EmbedBuilder()
					.setColor(0xf1c40f)
					.setTitle("🏆 Invite Leaderboard")
					.setDescription(lines.join("\n"));

				return interaction.reply({ embeds: [embed], ephemeral: true });
			}
		},
	};
}

function createInvitesAdminCommand(InviteStatsModel, InviteCodeModel, JoinLogModel, db) {
	return {
		data: {
			name: "invites-admin",
			description: "Manage invites (admin)",
			defaultMemberPermissions: "ManageGuild",
			options: [
				{
					name: "add",
					description: "Add bonus invites to a user",
					type: 1,
					options: [
						{
							name: "user",
							type: 6,
							description: "User to give bonus invites",
							required: true,
						},
						{
							name: "amount",
							type: 4,
							description: "Number of bonus invites",
							required: true,
							minValue: 1,
						},
					],
				},
				{
					name: "codes",
					description: "List active invite codes and their creators",
					type: 1,
				},
				{
					name: "sync",
					description: "Sync invite codes from Discord",
					type: 1,
				},
			],
		},
		async execute(interaction) {
			const sub = interaction.options.getSubcommand();
			const guildId = interaction.guildId;

			if (sub === "add") {
				const target = interaction.options.getUser("user");
				const amount = interaction.options.getInteger("amount");
				const stats = await InviteStatsModel.findOneAndUpdate(
					{ guildId, userId: target.id },
					{ $inc: { bonusInvites: amount, totalInvites: amount } },
					{ upsert: true, new: true }
				);
				return interaction.reply({
					content: `Added ${amount} bonus invite(s) to ${target.tag}. Total: ${stats.totalInvites}`,
					ephemeral: true,
				});
			}

			if (sub === "codes") {
				const guild = await interaction.client.guilds.fetch(guildId);
				const invites = await guild.invites.fetch().catch(() => null);
				if (!invites || invites.size === 0) {
					return interaction.reply({ content: "No active invite codes.", ephemeral: true });
				}
				const lines = invites.map(
					(i) => `\`${i.code}\` — ${i.uses} use(s) — by <@${i.inviter?.id || "unknown"}>`
				);
				return interaction.reply({ content: lines.join("\n").substring(0, 1900), ephemeral: true });
			}

			if (sub === "sync") {
				const guild = await interaction.client.guilds.fetch(guildId);
				const invites = await guild.invites.fetch().catch(() => []);
				for (const invite of invites.values()) {
					await InviteCodeModel.findOneAndUpdate(
						{ guildId, code: invite.code },
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
				return interaction.reply({
					content: `Synced ${invites.size} invite code(s) from Discord.`,
					ephemeral: true,
				});
			}
		},
	};
}

function makeStatsEmbed(user, stats) {
	return new EmbedBuilder()
		.setColor(0x57f287)
		.setTitle(`📨 Invites — ${user.tag}`)
		.addFields(
			{ name: "Total", value: String(stats.totalInvites), inline: true },
			{ name: "Regular", value: String(stats.regularInvites), inline: true },
			{ name: "Leaves", value: String(stats.leaveInvites), inline: true },
			{ name: "Fake", value: String(stats.fakeInvites), inline: true },
			{ name: "Bonus", value: String(stats.bonusInvites), inline: true }
		);
}

module.exports = { createInvitesCommand, createInvitesAdminCommand, makeStatsEmbed };