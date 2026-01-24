import { spawn } from 'node:child_process';

/**
 * Kills a process tree starting from the given PID.
 * Works on Windows and Unix-like systems.
 *
 * @param pid - The root process ID to kill.
 */
export async function killProcessTree(pid: number): Promise<void> {
	if (process.platform === 'win32') {
		await new Promise<void>((resolve, reject) => {
			const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
				windowsHide: true,
			});
			child.on('error', reject);
			child.on('close', () => resolve());
		});
		return;
	}

	// On Unix, if the process was spawned with `detached: true`, it becomes a process group leader.
	// Killing the negative PID kills the entire group (best-effort).
	try {
		process.kill(-pid, 'SIGTERM');
	} catch {
		try {
			process.kill(pid, 'SIGTERM');
		} catch {
			// ignore
		}
	}

	// Best-effort escalation to SIGKILL after a short delay.
	await new Promise<void>(resolve => setTimeout(resolve, 600));
	try {
		process.kill(-pid, 'SIGKILL');
	} catch {
		try {
			process.kill(pid, 'SIGKILL');
		} catch {
			// ignore
		}
	}
}
