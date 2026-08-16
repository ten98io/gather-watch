/**
 * Playback-master claim arbitration for a room.
 *
 * RoomDoc.master.epoch is monotonic per room BECAUSE every transition is a
 * compare-and-set from the exact previous master value (both store adapters
 * match embedded objects structurally, and this module always writes master
 * objects with key order { userId, epoch } so the Mongo embedded-document
 * match stays exact). The client names the epoch its claim is based on; the
 * SERVER increments — a lost CAS or a mismatched epoch means the claim was
 * stale and is rejected with CONFLICT.
 */
import type { RoomId, UserId } from '@gather/contracts';
import { AppError } from '../../lib/errors';
import type { Deps } from '../types';

/** Claim playback-master for the room at the caller-known epoch. */
export async function claimMaster(
  deps: Deps,
  roomId: RoomId,
  userId: UserId,
  claimEpoch: number,
): Promise<void> {
  const room = await deps.store.rooms.findById(roomId);
  if (room === null) {
    throw new AppError('NOT_FOUND', 'room not found');
  }
  const stored = room.master;
  const storedEpoch = stored?.epoch ?? 0;
  if (claimEpoch !== storedEpoch) {
    throw new AppError('CONFLICT', `stale epoch claim: current epoch is ${storedEpoch}`);
  }
  const next = { userId, epoch: storedEpoch + 1 };
  const updated = await deps.store.rooms.updateOne(
    { id: roomId, master: stored ?? null },
    { master: next },
  );
  if (updated === null) {
    // Lost the CAS race — re-read so the error reports the CURRENT epoch.
    const current = await deps.store.rooms.findById(roomId);
    throw new AppError(
      'CONFLICT',
      `stale epoch claim: current epoch is ${current?.master?.epoch ?? 0}`,
    );
  }
  await deps.events.emit(roomId, 'sync.masterChanged', {
    masterUserId: userId,
    epoch: storedEpoch + 1,
  });
}
