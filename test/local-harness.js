"use strict";

/**
 * local-harness.js — offline smoke test for adb-plugin-invite-tracker.
 * Run: npm test   (node test/local-harness.js). No bot / no Mongo.
 */

const { createMockCtx } = require("./mock-ctx");
const { InviteStatsSchema } = require("../models/invite");
const { load } = require("../index");

let passed = 0;
let failed = 0;
function assert(cond, label) {
	if (cond) {
		console.log(`  PASS  ${label}`);
		passed++;
	} else {
		console.error(`  FAIL  ${label}`);
		failed++;
	}
}

// Minimal fake user directory so leaderboard's client.users.fetch resolves tags.
const users = {
	"user-1": { id: "user-1", tag: "Alice#0001" },
	"user-2": { id: "user-2", tag: "Bob#0002" },
};

// Fake interaction. `opts` maps option-name -> value; `_sub` is the subcommand.
function fakeInteraction(_sub, opts = {}, asUser = "user-1") {
	const replies = [];
	return {
		guildId: "guild-1",
		user: users[asUser],
		client: {
			users: { fetch: async (id) => users[id] || null },
		},
		options: {
			getSubcommand: () => _sub,
			getUser: (n) => (opts[n] ? users[opts[n]] || { id: opts[n], tag: opts[n] } : null),
			getInteger: (n) => (n in opts ? opts[n] : null),
			getString: (n) => (n in opts ? opts[n] : null),
		},
		reply: async (payload) => {
			replies.push(payload);
			return payload;
		},
		replies,
	};
}

async function run() {
	console.log("\n=== adb-plugin-invite-tracker — Local Harness ===\n");

	const { ctx, registeredCommands } = createMockCtx({ pluginName: "adb-plugin-invite-tracker" });
	await load(ctx);

	assert(registeredCommands.has("invites"), "/invites registered");
	assert(registeredCommands.has("invites-admin"), "/invites-admin registered");

	const invites = registeredCommands.get("invites");
	const admin = registeredCommands.get("invites-admin");

	// Cached model — same instance load() defined.
	const Stats = ctx.defineModel("inviteStats", InviteStatsSchema);

	// --- /invites me (empty) ---
	const meEmpty = fakeInteraction("me");
	await invites.execute(meEmpty);
	assert(/haven't invited anyone/.test(meEmpty.replies[0].content), "me: empty -> no invites message");

	// --- seed stats then /invites me ---
	await Stats.create({ guildId: "guild-1", userId: "user-1", totalInvites: 5, regularInvites: 4, bonusInvites: 1 });
	const me = fakeInteraction("me");
	await invites.execute(me);
	assert(!!me.replies[0].embeds, "me: seeded -> embed returned");

	// --- /invites user (another user, empty) ---
	const userEmpty = fakeInteraction("user", { user: "user-2" });
	await invites.execute(userEmpty);
	assert(/hasn't invited anyone/.test(userEmpty.replies[0].content), "user: empty target -> no invites message");

	// --- /invites leaderboard (has data) ---
	await Stats.create({ guildId: "guild-1", userId: "user-2", totalInvites: 8, regularInvites: 8 });
	const lb = fakeInteraction("leaderboard");
	await invites.execute(lb);
	assert(!!lb.replies[0].embeds, "leaderboard: embed returned");
	// Note: mock model .sort() is a no-op, so we assert membership/formatting, not order.
	const desc = lb.replies[0].embeds[0].data.description;
	assert(/Alice#0001/.test(desc) && /Bob#0002/.test(desc), "leaderboard: lists tracked inviters");
	assert(/8 invite\(s\)/.test(desc), "leaderboard: shows invite counts");

	// --- /invites-admin add ---
	const add = fakeInteraction("add", { user: "user-1", amount: 3 });
	await admin.execute(add);
	assert(/Added 3 bonus invite/.test(add.replies[0].content), "admin add: replies with confirmation");
	assert(/Total: 8/.test(add.replies[0].content), "admin add: totalInvites incremented (5 -> 8)");

	console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
	process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
	console.error("Harness crashed:", err);
	process.exit(1);
});
