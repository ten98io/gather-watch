import type { Metadata } from 'next';
import type { InviteCode } from '@playin/contracts';
import { JoinClient } from './join-client';

export const metadata: Metadata = { title: 'Join the room' };

/** Guest join landing: /join/<inviteCode>. */
export default async function JoinPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <JoinClient code={code as InviteCode} />;
}
