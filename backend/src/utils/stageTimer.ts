/**
 * Per-request stage timing, for finding where time goes.
 *
 * A timer records how long each named stage took (milliseconds since the
 * previous mark). It holds only stage names and numbers: never an email, a
 * password, a token, a cookie or any profile data. `logTiming` writes ONE
 * single-line JSON record carrying the request id (the X-Request-Id header the
 * client also sees) and an outcome word, so a slow request can be matched to
 * its stages without logging anything personal.
 */

export interface StageTimer {
  /** Ends the stage that has been running since the previous mark. */
  mark: (stage: string) => void;
  /** Stage durations in ms, in the order they were marked, plus the total. */
  summary: () => { totalMs: number; stages: Record<string, number> };
}

const now = () => Number(process.hrtime.bigint()) / 1e6;
const round = (value: number) => Math.round(value * 10) / 10;

export const createStageTimer = (): StageTimer => {
  const started = now();
  let last = started;
  const stages: Record<string, number> = {};
  return {
    mark: (stage) => {
      const t = now();
      stages[stage] = round((stages[stage] ?? 0) + (t - last));
      last = t;
    },
    summary: () => ({ totalMs: round(now() - started), stages: { ...stages } }),
  };
};

/** One line, one JSON object: `{"<event>":{"requestId":…,"outcome":…,"totalMs":…,"stages":{…}}}`. */
export const logTiming = (event: string, requestId: string | undefined, outcome: string, timer: StageTimer) => {
  const { totalMs, stages } = timer.summary();
  console.log(JSON.stringify({ [event]: { requestId: requestId ?? null, outcome, totalMs, stages } }));
};
