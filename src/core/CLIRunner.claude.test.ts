/**
 * @file CLIRunner Claude contract tests
 * @description Verifies PrimeCode's Claude CLI integration contract against Kanban semantics.
 *              Uses a test double to capture spawn args without invoking external CLI.
 */

import { describe, expect, it } from 'vitest';
import { CLIRunner } from './CLIRunner';

function getClaudeExecutorForTest(): any {
	const runner = new CLIRunner('claude');
	return (runner as unknown as { executor: unknown }).executor as any;
}

describe('Claude follow-up contract (Kanban parity)', () => {
	it('uses --fork-session --resume <sessionId> for follow-up', async () => {
		const exec = getClaudeExecutorForTest();
		const calls: unknown[] = [];

		exec.spawnProcess = (command: string, args: string[], options: unknown) => {
			calls.push({ command, args, options });
			return {
				stdout: { on: () => {} },
				stderr: { on: () => {} },
				on: () => {},
			} as any;
		};

		await exec.spawnFollowUp('hi', 'sess-1', {
			provider: 'claude',
			workspaceRoot: 'C:/repo',
		});

		expect(calls).toHaveLength(1);
		const first = calls[0] as { args: string[] };
		expect(first.args).toEqual(expect.arrayContaining(['--fork-session', '--resume', 'sess-1']));
	});

	it('exposes SessionFork capability for future executor compatibility', () => {
		const exec = getClaudeExecutorForTest();
		expect(exec.getCapabilities?.()).toEqual(expect.arrayContaining(['SessionFork']));
	});
});
