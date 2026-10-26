/** Keep existing installations working while exposing the new public name. */
export function guardEnvironment(environment = process.env) {
  const result = { ...environment };
  for (const suffix of ['CODEX_BINARY', 'STATE_DIR', 'POLL_MS', 'REQUEST_TIMEOUT_MS', 'STOP_GRACE_MS']) {
    const value = environment[`CODEX_BRAKE_${suffix}`];
    if (value !== undefined) result[`RESETSTOP_${suffix}`] = value;
  }
  return result;
}
