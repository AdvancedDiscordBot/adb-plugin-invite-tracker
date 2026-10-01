# adb-plugin-invite-tracker

Track who invites whom in your Discord server with a detailed leaderboard.

## Commands (Users)

- `/invites me` — Check your invite stats
- `/invites user <user>` — Check another user's invites
- `/invites leaderboard` — Top 10 inviters

## Commands (Admin)

- `/invites-admin add <user> <amount>` — Add bonus invites
- `/invites-admin codes` — List active invite codes
- `/invites-admin sync` — Sync invites from Discord

## Features

- Automatic tracking — detects which invite code was used on each join
- Leave deduction — when an invited member leaves, credit is removed
- Bonus invites — manually reward invites
- Milestone roles — auto-assign roles at invite thresholds (`roleID:count` in config)
- Join logging — tracks which code was used for leave deduction

## Config

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | true | Enable tracking and invite commands for this server |
| `trackLeaves` | true | Deduct invites on leave |
| `bonusRoles` | — | `roleID:count,roleID:count` — auto-assign roles at milestones |

Invite caches are refreshed on client readiness, runtime load, new guilds, and
manual sync. Joins and leaves are serialized per guild; duplicate join/leave
events do not change credit twice. Disabling leave deductions still clears the
departed member's join record so a later rejoin can be tracked.

Discord does not include the invite code in member-join events. Ambiguous changes,
missing permissions, and unavailable/deleted invites remain unattributed. A
fresh baseline is required after a fetch failure or an observed disabled state.
Extra uses of a single invite are kept for up to ten seconds for queued joins.
Unattributed joins have nullable inviter/code fields and never deduct credit.
Serialization is per process; cross-process or crash-atomic accounting still
requires database transactions or durable event claims.

## License

This project is licensed under the **GNU Affero General Public License v3.0**. See the [LICENSE](LICENSE) file for details.

This repository follows the policies of the main ADB project.

- **Contribution Guidelines**: [CONTRIBUTING.md](https://github.com/AdvancedDiscordBot/Advanced-Discord-Bot/blob/main/CONTRIBUTING.md)
- **Code of Conduct**: [CODE_OF_CONDUCT.md](https://github.com/AdvancedDiscordBot/Advanced-Discord-Bot/blob/main/CODE_OF_CONDUCT.md)
- **Security Policy**: [SECURITY.md](https://github.com/AdvancedDiscordBot/Advanced-Discord-Bot/blob/main/SECURITY.md)
