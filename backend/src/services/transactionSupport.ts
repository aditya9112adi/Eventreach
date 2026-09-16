import mongoose from 'mongoose';

/**
 * Whether the connected MongoDB deployment supports multi-document
 * transactions.
 *
 * Transactions need a replica set or a sharded cluster. MongoDB Atlas is always
 * one of those, but a plain local `mongod` used for development is standalone
 * and rejects a transaction outright. Rather than require a particular setup,
 * callers ask here and fall back to an ordered, retry-safe sequence of writes
 * when a transaction is not available.
 *
 * The answer cannot change without reconnecting, so it is cached per
 * connection.
 */
let cached: { connection: unknown; supported: boolean } | null = null;

export const supportsTransactions = async (): Promise<boolean> => {
  const db = mongoose.connection.db;
  if (!db) return false;
  if (cached && cached.connection === db) return cached.supported;

  let supported = false;
  try {
    const hello: any = await db.admin().command({ hello: 1 });
    // setName: replica set member. msg 'isdbgrid': mongos in a sharded cluster.
    supported = Boolean(hello?.setName) || hello?.msg === 'isdbgrid';
  } catch {
    supported = false;
  }
  cached = { connection: db, supported };
  return supported;
};
