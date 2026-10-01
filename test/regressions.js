"use strict";

const assert = require("node:assert/strict");
const { ChatInputCommandInteraction, Client, Collection, Events } = require("discord.js");
const { createMockCtx } = require("./mock-ctx");
const { InviteCodeSchema } = require("../models/invite");
const { load } = require("../index");

const PLUGIN = "adb-plugin-invite-tracker";

async function setup({ ready = true, config = {} } = {}) {
	const mock = createMockCtx({ pluginName: PLUGIN });
	const errors = [];
	const live = new Collection([["code", { code: "code", uses: 0, inviter: { id: "inviter" } }]]);
	let fetches = 0;
	const roles = [];
	const guild = {
		id: "guild",
		invites: { fetch: async () => {
			fetches++;
			return new Collection([...live].map(([code, invite]) => [code, { ...invite }]));
		} },
		roles: { fetch: async (id) => ({ id }) },
		members: { fetch: async () => ({ roles: { cache: new Collection(), add: async (role) => roles.push(role.id) } }) },
	};
	mock.ctx.client.guilds.cache.set(guild.id, guild);
	mock.ctx.client.guilds.fetch = async () => guild;
	mock.ctx.client.isReady = () => ready;
	mock.ctx.logger.error = (...args) => errors.push(args);
	await mock.ctx.db.updatePluginConfig(guild.id, PLUGIN, config);
	const codes = mock.ctx.defineModel("inviteCode", InviteCodeSchema);
	await codes.create({ guildId: guild.id, code: "code", creatorId: "inviter", uses: 0 });
	await load(mock.ctx);
	return {
		...mock, guild, live, roles, errors, codes, fetches: () => fetches,
		stats: mock.models.get(`plugin_${PLUGIN}_inviteStats`),
		joins: mock.models.get(`plugin_${PLUGIN}_joinLog`),
		member: (id = "member") => ({ id, guild, joinedTimestamp: Date.now() }),
	};
}

module.exports = async function regressions() {
	let passed = 0;
	let failed = 0;
	async function test(name, run) {
		try {
			await run();
			passed++;
			console.log(`PASS ${name}`);
		} catch (error) {
			failed++;
			console.error(`FAIL ${name}: ${error.stack}`);
		}
	}

	await test("runtime load warms invite counts on an already-ready client", async () => {
		const { fetches, codes } = await setup();
		assert.equal(fetches(), 1);
		assert.equal((await codes.findOne({ guildId: "guild", code: "code" })).uses, 0);
	});

	await test("the current Discord client-ready event replaces stale cached invites", async () => {
		const { codes, live, emitEvent, fetches } = await setup({ ready: false });
		await codes.create({ guildId: "guild", code: "stale", creatorId: "inviter", uses: 3 });
		live.get("code").uses = 7;
		assert.equal(fetches(), 0);
		await emitEvent(Events.ClientReady);
		assert.equal(fetches(), 1);
		assert.equal(await codes.findOne({ code: "stale" }), null);
		assert.equal((await codes.findOne({ code: "code" })).uses, 7);
	});

	await test("guildCreate warms and guildDelete removes only that guild's invite cache", async () => {
		const { ctx, guild, codes, emitEvent } = await setup();
		const other = { id: "other", invites: { fetch: async () => new Collection([["other-code", { code: "other-code", uses: 4, inviter: { id: "other-inviter" } }]]) } };
		ctx.client.guilds.cache.set(other.id, other);
		await emitEvent("guildCreate", other);
		assert.equal((await codes.findOne({ guildId: other.id }))?.uses, 4);
		await emitEvent("guildDelete", other);
		assert.equal(await codes.findOne({ guildId: other.id }), null);
		assert.ok(await codes.findOne({ guildId: guild.id }));
	});

	await test("disabled tracking gates joins, invite creation and command execution", async () => {
		const { ctx, guild, live, emitEvent, codes, stats, joins, roles, member, fetches, registeredCommands } = await setup({ config: { enabled: false, bonusRoles: "reward:1" } });
		live.get("code").uses = 1;
		await emitEvent("guildMemberAdd", member());
		await emitEvent("inviteCreate", { guild, code: "disabled", uses: 0 });
		assert.equal(await stats.countDocuments({}), 0);
		assert.equal(await joins.countDocuments({}), 0);
		assert.equal(await codes.findOne({ code: "disabled" }), null);
		assert.equal(fetches(), 0);
		assert.deepEqual(roles, []);
		const replies = [];
		await registeredCommands.get("invites").execute({ guildId: guild.id, user: { id: "user" }, options: { getSubcommand: () => "me" }, deferReply: async () => {}, editReply: async (payload) => replies.push(payload) });
		assert.match(replies[0].content, /disabled/i);
		await ctx.db.updatePluginConfig(guild.id, PLUGIN, { enabled: true });
		await emitEvent("guildMemberAdd", member("after-enable"));
		assert.equal(await stats.countDocuments({}), 0, "do not attribute counts accumulated while disabled");
	});

	await test("concurrent duplicate joins cannot increment or consume the next member's credit", async () => {
		const { guild, live, emitEvent, stats, joins, codes, member } = await setup();
		const findOne = codes.findOne;
		codes.findOne = async (query) => {
			const doc = await findOne(query);
			return doc ? { ...doc } : null;
		};
		live.get("code").uses = 1;
		await Promise.all([emitEvent("guildMemberAdd", member()), emitEvent("guildMemberAdd", member())]);
		assert.equal((await stats.findOne({ guildId: guild.id, userId: "inviter" })).totalInvites, 1);
		assert.equal(await joins.countDocuments({}), 1);
		live.get("code").uses = 2;
		await emitEvent("guildMemberAdd", member());
		await emitEvent("guildMemberAdd", member("next-member"));
		assert.equal((await stats.findOne({ userId: "inviter" })).totalInvites, 2);
		assert.ok(await joins.findOne({ userId: "next-member" }));
	});

	await test("one snapshot can credit two queued joins using the same invite", async () => {
		const { live, emitEvent, stats, joins, member } = await setup();
		live.get("code").uses = 2;
		await Promise.all([emitEvent("guildMemberAdd", member("one")), emitEvent("guildMemberAdd", member("two"))]);
		assert.equal((await stats.findOne({ userId: "inviter" })).totalInvites, 2);
		assert.equal(await joins.countDocuments({}), 2);
	});

	await test("duplicate leaves deduct credit only once and allow a genuine rejoin", async () => {
		const { live, emitEvent, stats, joins, member } = await setup();
		live.get("code").uses = 1;
		await emitEvent("guildMemberAdd", member());
		await Promise.all([emitEvent("guildMemberRemove", member()), emitEvent("guildMemberRemove", member())]);
		let inviter = await stats.findOne({ userId: "inviter" });
		assert.equal(inviter.totalInvites, 0);
		assert.equal(inviter.leaveInvites, 1);
		assert.equal(await joins.countDocuments({}), 0);
		live.get("code").uses = 2;
		await emitEvent("guildMemberAdd", member());
		inviter = await stats.findOne({ userId: "inviter" });
		assert.equal(inviter.totalInvites, 1);
	});

	for (const config of [{ trackLeaves: false }, { enabled: false }]) {
		await test(`${Object.keys(config)[0]}=false prevents leave deductions but clears membership`, async () => {
			const { ctx, guild, live, emitEvent, stats, joins, member } = await setup();
			live.get("code").uses = 1;
			await emitEvent("guildMemberAdd", member());
			await ctx.db.updatePluginConfig(guild.id, PLUGIN, config);
			await emitEvent("guildMemberRemove", member());
			const inviter = await stats.findOne({ userId: "inviter" });
			assert.equal(inviter.totalInvites, 1);
			assert.equal(inviter.leaveInvites, 0);
			assert.equal(await joins.countDocuments({}), 0);
		});
	}

	await test("unmatched joins refresh all invite metadata without stealing later attribution", async () => {
		const { live, codes, emitEvent, stats, joins, member } = await setup();
		live.set("new", { code: "new", uses: 10, inviter: { id: "new-inviter" } });
		live.delete("code");
		await emitEvent("guildMemberAdd", member("unknown"));
		assert.equal(await codes.findOne({ code: "code" }), null);
		assert.equal((await codes.findOne({ code: "new" })).uses, 10);
		assert.equal(await stats.countDocuments({}), 0);
		live.get("new").uses = 11;
		await emitEvent("guildMemberAdd", member("unknown"));
		await emitEvent("guildMemberAdd", member("known"));
		assert.equal((await joins.findOne({ userId: "known" }))?.inviterId, "new-inviter");
		await emitEvent("guildMemberRemove", member("unknown"));
		assert.equal((await stats.findOne({ userId: "new-inviter" })).totalInvites, 1);
	});

	await test("multiple changed invite codes are ambiguous, not an arbitrary first match", async () => {
		const { guild, live, codes, emitEvent, stats, member } = await setup();
		await codes.create({ guildId: guild.id, code: "other", creatorId: "other-inviter", uses: 0 });
		live.set("other", { code: "other", uses: 1, inviter: { id: "other-inviter" } });
		live.get("code").uses = 1;
		await emitEvent("guildMemberAdd", member());
		assert.equal(await stats.countDocuments({}), 0);
		assert.equal((await codes.findOne({ code: "code" })).uses, 1);
		assert.equal((await codes.findOne({ code: "other" })).uses, 1);
	});

	await test("fetch failures invalidate the baseline without poisoning later guild events", async () => {
		const { guild, live, emitEvent, stats, member } = await setup();
		const fetch = guild.invites.fetch;
		guild.invites.fetch = async () => { throw new Error("no invite permissions"); };
		await emitEvent("guildMemberAdd", member("missed"));
		guild.invites.fetch = fetch;
		live.get("code").uses = 5;
		await emitEvent("guildMemberAdd", member("baseline"));
		assert.equal(await stats.countDocuments({}), 0);
		live.get("code").uses = 6;
		await emitEvent("guildMemberAdd", member("tracked"));
		assert.equal((await stats.findOne({ userId: "inviter" })).totalInvites, 1);
	});

	await test("a failed invite increment cannot cause an unearned leave deduction", async () => {
		const { guild, live, emitEvent, stats, member } = await setup();
		await stats.create({ guildId: guild.id, userId: "inviter", totalInvites: 5, regularInvites: 5 });
		const update = stats.findOneAndUpdate;
		stats.findOneAndUpdate = async () => { throw new Error("write failed"); };
		live.get("code").uses = 1;
		await emitEvent("guildMemberAdd", member());
		stats.findOneAndUpdate = update;
		await emitEvent("guildMemberRemove", member());
		assert.equal((await stats.findOne({ userId: "inviter" })).totalInvites, 5);
	});

	await test("admin sync replaces stale codes and reports fetch failure honestly", async () => {
		const { ctx, guild, codes, registeredCommands } = await setup();
		await codes.create({ guildId: guild.id, code: "stale", creatorId: "inviter", uses: 0 });
		const replies = [];
		const interaction = { guildId: guild.id, client: ctx.client, options: { getSubcommand: () => "sync" }, deferReply: async () => {}, editReply: async (payload) => replies.push(payload) };
		await registeredCommands.get("invites-admin").execute(interaction);
		assert.equal(await codes.findOne({ code: "stale" }), null);
		assert.match(replies[0].content, /Synced 1/);
		guild.invites.fetch = async () => { throw new Error("forbidden"); };
		await registeredCommands.get("invites-admin").execute(interaction);
		assert.match(replies[1].content, /unable|failed/i);
		assert.ok(await codes.findOne({ code: "code" }), "a failed fetch must not clear the last known cache");
	});

	for (const [command, subcommand] of [["invites", "me"], ["invites-admin", "sync"]]) {
		await test(`${command} acknowledges before slow config and Discord work`, async () => {
			const { ctx, guild, registeredCommands } = await setup();
			const client = new Client({ intents: [] });
			const callbacks = [];
			const replies = [];
			let elapsed = 0;
			client.guilds.fetch = async () => guild;
			client.rest.post = async (route, { body }) => {
				if (elapsed >= 3000) throw Object.assign(new Error("Unknown interaction"), { code: 10062 });
				callbacks.push(body);
				return {};
			};
			const interaction = new ChatInputCommandInteraction(client, {
				id: "100000000000000001", application_id: "100000000000000002", token: "offline",
				type: 2, guild_id: guild.id, user: { id: "100000000000000003", username: "member", discriminator: "0" },
				data: { id: "100000000000000004", name: command, type: 1, options: [{ name: subcommand, type: 1 }] }, entitlements: [],
			});
			interaction.webhook.editMessage = async (id, payload) => { replies.push(payload); return payload; };
			const getConfig = ctx.db.getPluginConfig;
			ctx.db.getPluginConfig = async (...args) => { elapsed += 4000; return getConfig(...args); };
			try {
				await registeredCommands.get(command).execute(interaction, client);
				assert.equal(callbacks.length, 1);
				assert.equal(callbacks[0].type, 5, "use a deferred initial response, then edit it");
				assert.equal(callbacks[0].data.flags, 64);
				assert.equal(replies.length, 1);
				assert.match(replies[0].content, subcommand === "sync" ? /Synced 1/ : /haven't invited/);
			} finally {
				client.destroy();
			}
		});
	}

	await test("invite lifecycle events remain serialized with joins and grant milestone roles", async () => {
		const { guild, live, emitEvent, codes, joins, roles, member } = await setup({ config: { bonusRoles: "reward:1" } });
		const invite = { guild, code: "created", uses: 0, inviter: { id: "creator" }, maxUses: 10 };
		live.set(invite.code, invite);
		await emitEvent("inviteCreate", invite);
		assert.equal((await codes.findOne({ code: invite.code })).maxUses, 10);
		invite.uses = 1;
		await emitEvent("guildMemberAdd", member());
		assert.equal((await joins.findOne({ userId: "member" })).inviterId, "creator");
		assert.deepEqual(roles, ["reward"]);
		live.delete(invite.code);
		await emitEvent("inviteDelete", { guild, code: invite.code });
		assert.equal(await codes.findOne({ code: invite.code }), null);
	});

	await test("unload drains active work and ignores events from stale listeners", async () => {
		const { ctx, guild, live, emitEvent, stats, member } = await setup();
		let release;
		let started;
		const blocked = new Promise((resolve) => { release = resolve; });
		const fetching = new Promise((resolve) => { started = resolve; });
		const fetch = guild.invites.fetch;
		guild.invites.fetch = async () => { started(); await blocked; return fetch(); };
		live.get("code").uses = 1;
		const join = emitEvent("guildMemberAdd", member());
		await fetching;
		const unload = ctx.hooks.emitHook("onPluginUnload", { pluginName: PLUGIN });
		release();
		await Promise.all([join, unload]);
		live.get("code").uses = 2;
		await emitEvent("guildMemberAdd", member("ignored"));
		assert.equal((await stats.findOne({ userId: "inviter" })).totalInvites, 1);
	});

	console.log(`Invite tracker regressions: ${passed} passed, ${failed} failed`);
	return { passed, failed };
};
