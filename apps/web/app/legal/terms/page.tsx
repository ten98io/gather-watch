import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Terms of Service' };

export default function TermsPage() {
  return (
    <>
      <h1>Terms of Service</h1>
      <p><em>Last updated: 2026. Gather is self-hosted software; these terms govern use of this instance.</em></p>

      <h2>1. The service</h2>
      <p>
        Gather provides private, invite-only watch-party rooms: synchronized media playback,
        voice/video calls, and chat. There is no public directory — rooms are reachable only
        through invite links created by their members.
      </p>

      <h2>2. Your responsibilities</h2>
      <p>
        You are responsible for the content you stream, upload, and share, and for having the
        rights to share it. Screen re-streaming is for unprotected and user-made content only.
        Do not use Gather to infringe copyright, harass others, or distribute illegal material.
      </p>

      <h2>3. What it costs</h2>
      <p>
        Nothing. Gather is free and every feature is available to everyone — there is no
        account level to buy, nothing to cancel, and we never ask you for payment details.
        Some limits still apply, because media travels directly between devices and storage
        is finite: a room caps how many people can be on camera or mic at once, and uploads
        count against a storage limit. Those limits come from capacity, and they are the
        same for everyone.
      </p>

      <h2>4. Moderation</h2>
      <p>
        Room hosts and moderators may kick or ban members. Instance operators act only on
        reported abuse (see the Abuse page). Private rooms stay private: we do not scan chat
        content or track what you play.
      </p>

      <h2>5. Liability</h2>
      <p>
        The service is provided “as is”, without warranties of any kind. To the maximum extent
        permitted by law, the instance operator is not liable for indirect or consequential
        damages arising from its use.
      </p>
    </>
  );
}
