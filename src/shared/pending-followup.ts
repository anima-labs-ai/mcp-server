/**
 * Pending Follow-Up Scheduler
 *
 * Tracks blocked outbound messages and schedules escalating follow-up reminders.
 * Ported from old anima MCP server.
 *
 * Schedule: 12h → 6h → 3h → 1h → 3-day cooldown → repeat
 */

export interface FollowUpNotification {
	pendingId: string;
	recipient: string;
	subject: string;
	attempt: number;
	isFinalBeforeCooldown: boolean;
	message: string;
}

interface TrackedPending {
	pendingId: string;
	recipient: string;
	subject: string;
	checkFn: () => Promise<boolean>;
	step: number;
	cycle: number;
	timer: ReturnType<typeof setTimeout> | null;
}

const STEP_DELAYS_MS = [
	12 * 60 * 60 * 1000, // 12 hours
	6 * 60 * 60 * 1000, // 6 hours
	3 * 60 * 60 * 1000, // 3 hours
	1 * 60 * 60 * 1000, // 1 hour
] as const;

const COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const HEARTBEAT_MS = 5 * 60 * 1000; // 5 minutes

const tracked = new Map<string, TrackedPending>();
const notifications: FollowUpNotification[] = [];
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function ensureHeartbeat(): void {
	if (heartbeatTimer) return;
	heartbeatTimer = setInterval(async () => {
		for (const [id, entry] of tracked) {
			try {
				const resolved = await entry.checkFn();
				if (resolved) {
					if (entry.timer) clearTimeout(entry.timer);
					tracked.delete(id);
				}
			} catch {
				// Check failed, keep tracking
			}
		}
		if (tracked.size === 0 && heartbeatTimer) {
			clearInterval(heartbeatTimer);
			heartbeatTimer = null;
		}
	}, HEARTBEAT_MS);
	if (heartbeatTimer && typeof heartbeatTimer === "object" && "unref" in heartbeatTimer) {
		heartbeatTimer.unref();
	}
}

function arm(entry: TrackedPending): void {
	const delayIdx = Math.min(entry.step, STEP_DELAYS_MS.length - 1);
	const isFinal = entry.step >= STEP_DELAYS_MS.length - 1;
	const delay = isFinal && entry.step > delayIdx ? COOLDOWN_MS : STEP_DELAYS_MS[delayIdx];

	entry.timer = setTimeout(() => fire(entry), delay);
	if (entry.timer && typeof entry.timer === "object" && "unref" in entry.timer) {
		entry.timer.unref();
	}
	tracked.set(entry.pendingId, entry);
}

async function fire(entry: TrackedPending): Promise<void> {
	try {
		const resolved = await entry.checkFn();
		if (resolved) {
			tracked.delete(entry.pendingId);
			return;
		}
	} catch {
		// Check failed, send reminder anyway
	}

	const isFinalBeforeCooldown = entry.step >= STEP_DELAYS_MS.length - 1;
	const attempt = entry.step + 1 + entry.cycle * STEP_DELAYS_MS.length;

	const cycleInfo =
		entry.cycle > 0 ? ` (cycle ${entry.cycle + 1})` : "";

	notifications.push({
		pendingId: entry.pendingId,
		recipient: entry.recipient,
		subject: entry.subject,
		attempt,
		isFinalBeforeCooldown,
		message: isFinalBeforeCooldown
			? `⚠️ FINAL REMINDER${cycleInfo}: Email to ${entry.recipient} "${entry.subject}" is still blocked (attempt ${attempt}). Next reminder in 3 days.`
			: `🔔 Reminder${cycleInfo}: Email to ${entry.recipient} "${entry.subject}" is still blocked (attempt ${attempt}). Use manage_pending_emails to review.`,
	});

	entry.step += 1;
	if (isFinalBeforeCooldown) {
		entry.step = 0;
		entry.cycle += 1;
	}

	arm(entry);
}

/**
 * Start tracking a blocked email for follow-up reminders.
 */
export function scheduleFollowUp(
	pendingId: string,
	recipient: string,
	subject: string,
	checkFn: () => Promise<boolean>,
): void {
	// Cancel existing tracking for this ID
	cancelFollowUp(pendingId);

	const entry: TrackedPending = {
		pendingId,
		recipient,
		subject,
		checkFn,
		step: 0,
		cycle: 0,
		timer: null,
	};

	arm(entry);
	ensureHeartbeat();
}

/**
 * Drain all queued follow-up notifications.
 * Returns notifications and clears the queue.
 */
export function drainFollowUps(): FollowUpNotification[] {
	const result = [...notifications];
	notifications.length = 0;
	return result;
}

/**
 * Cancel tracking for a specific pending email.
 */
export function cancelFollowUp(pendingId: string): boolean {
	const entry = tracked.get(pendingId);
	if (!entry) return false;

	if (entry.timer) clearTimeout(entry.timer);
	tracked.delete(pendingId);
	return true;
}

/**
 * Cancel all follow-up tracking and stop the heartbeat.
 */
export function cancelAllFollowUps(): void {
	for (const entry of tracked.values()) {
		if (entry.timer) clearTimeout(entry.timer);
	}
	tracked.clear();
	notifications.length = 0;

	if (heartbeatTimer) {
		clearInterval(heartbeatTimer);
		heartbeatTimer = null;
	}
}

/**
 * Get the number of actively tracked follow-ups.
 */
export function activeFollowUpCount(): number {
	return tracked.size;
}
