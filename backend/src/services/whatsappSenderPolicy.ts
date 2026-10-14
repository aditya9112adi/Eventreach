export const SENDER_STATUS_FRESHNESS_MS = 15 * 60 * 1000;

export const isSenderStatusFresh = (
  checkedAt: Date | string | null | undefined,
  now = Date.now()
): boolean => Boolean(
  checkedAt &&
  Number.isFinite(new Date(checkedAt).getTime()) &&
  now - new Date(checkedAt).getTime() < SENDER_STATUS_FRESHNESS_MS
);
