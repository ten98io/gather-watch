import type { Metadata } from 'next';
import type { RoomId } from '@gather/contracts';
import { RoomShell } from './room-shell';

export const metadata: Metadata = { title: 'Room' };

export default async function RoomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RoomShell roomId={id as RoomId} />;
}
