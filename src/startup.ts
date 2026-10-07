/** Startup budget only; healthy workers have no wall-clock task deadline. */
export function startupTimeoutMs(): number {
	const value = Number(process.env.PI_DISPATCH_STARTUP_TIMEOUT_MS);
	return Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647 ? value : 120_000;
}
