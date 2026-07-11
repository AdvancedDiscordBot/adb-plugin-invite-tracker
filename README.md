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
| `trackLeaves` | true | Deduct invites on leave |
| `bonusRoles` | — | `roleID:count,roleID:count` — auto-assign roles at milestones |

## License

This project is licensed under the **GNU Affero General Public License v3.0**. See the [LICENSE](LICENSE) file for details.

This repository follows the policies of the main ADB project.

- **Contribution Guidelines**: [CONTRIBUTING.md](https://github.com/AdvancedDiscordBot/Advanced-Discord-Bot/blob/main/CONTRIBUTING.md)
- **Code of Conduct**: [CODE_OF_CONDUCT.md](https://github.com/AdvancedDiscordBot/Advanced-Discord-Bot/blob/main/CODE_OF_CONDUCT.md)
- **Security Policy**: [SECURITY.md](https://github.com/AdvancedDiscordBot/Advanced-Discord-Bot/blob/main/SECURITY.md)
