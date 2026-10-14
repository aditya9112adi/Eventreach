import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';

/**
 * Requests that need the database wait here, bounded, while it is not
 * connected - for example while the driver reconnects after a drop - instead of
 * relying on the driver's silent command buffering, which ends after 10 s in a
 * generic 500. If the database does not come back in time the answer is a clear
 * 503 with Retry-After, never a hung request and never a misleading 500.
 * /health needs no database and always answers at once.
 *
 * It only reads the connection state: it never opens connections, retries on the
 * caller's behalf, or delays a request once the database is connected.
 */

export const DEFAULT_DB_READY_WAIT_MS = 20_000;

export interface DbConnectionLike {
  readyState: number;
  once: (event: 'connected', listener: () => void) => unknown;
  off: (event: 'connected', listener: () => void) => unknown;
}

const CONNECTED = 1;

/** Resolves true once connected, false if `maxWaitMs` passes first. */
export const waitForConnected = (connection: DbConnectionLike, maxWaitMs: number): Promise<boolean> =>
  new Promise((resolve) => {
    if (connection.readyState === CONNECTED) return resolve(true);
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.off('connected', onConnected);
      resolve(value);
    };
    const onConnected = () => finish(true);
    const timer = setTimeout(() => finish(connection.readyState === CONNECTED), maxWaitMs);
    connection.once('connected', onConnected);
  });

/** Paths that must answer without a database. */
const DATABASE_FREE_PATHS = new Set(['/health']);

export const waitForDatabase =
  (options: { maxWaitMs?: number; connection?: DbConnectionLike } = {}) =>
  async (req: Request, res: Response, next: NextFunction) => {
    if (DATABASE_FREE_PATHS.has(req.path)) return next();
    const connection = options.connection ?? (mongoose.connection as unknown as DbConnectionLike);
    if (connection.readyState === CONNECTED) return next();

    const maxWaitMs = options.maxWaitMs ?? (Number(process.env.DB_READY_WAIT_MS) || DEFAULT_DB_READY_WAIT_MS);
    if (await waitForConnected(connection, maxWaitMs)) return next();

    res.setHeader('Retry-After', '5');
    return res.status(503).json({ error: 'The server is starting up. Please try again in a moment.' });
  };
