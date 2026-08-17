export function canApplyObservedAt(
  previousObservedAt: string | null,
  incomingObservedAt: string | null,
): boolean {
  if (previousObservedAt === null) return true;
  if (incomingObservedAt === null) return false;
  const previousObservedAtMs = Date.parse(previousObservedAt);
  const incomingObservedAtMs = Date.parse(incomingObservedAt);
  return Number.isFinite(incomingObservedAtMs) &&
    (!Number.isFinite(previousObservedAtMs) || incomingObservedAtMs >= previousObservedAtMs);
}
