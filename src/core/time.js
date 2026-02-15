export function nowMs() {
  return Date.now();
}

export function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
