import type { Plugin } from "@opencode-ai/plugin";

export const SoundNotifications: Plugin = async ({ $ }) => {
	return {
		event: async ({ event }) => {
			if (event.type === "permission.updated") {
				// Play Ping sound for permission requests
				// await $`afplay /System/Library/Sounds/Ping.aiff`;
				await $`tput bel`;
			}

			if (event.type === "session.idle") {
				// Play Submarine sound when agent finishes
				// await $`afplay /System/Library/Sounds/Submarine.aiff`;
				await $`tput bel`;
			}
		},
	};
};
