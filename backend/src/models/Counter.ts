import mongoose, { Schema } from 'mongoose';

/**
 * Atomic sequence source for human-readable identifiers (currently the Event ID).
 *
 * One document per sequence, e.g. { _id: "events", seq: 42 }. `nextSequence`
 * uses a single findOneAndUpdate with $inc, which MongoDB executes atomically,
 * so concurrent event creations can never receive the same number and there is
 * no collision-handling code to get wrong.
 */
export interface ICounter {
  _id: string;
  seq: number;
}

const CounterSchema = new Schema<ICounter>({
  _id: { type: String, required: true },
  seq: { type: Number, required: true, default: 0, min: 0, validate: { validator: Number.isInteger, message: 'seq must be a whole number' } },
});

export const Counter = mongoose.model<ICounter>('Counter', CounterSchema);

/** Returns the next value for `name`, creating the counter on first use. */
export const nextSequence = async (name: string): Promise<number> => {
  const doc = await Counter.findByIdAndUpdate(
    name,
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  ).lean();
  return (doc as any).seq;
};

/** "EVT-" + zero-padded to at least 6 digits (grows naturally past a million). */
export const formatEventId = (seq: number): string => `EVT-${String(seq).padStart(6, '0')}`;
