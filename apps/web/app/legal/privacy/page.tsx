import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Privacy Policy' };

export default function PrivacyPage() {
  return (
    <>
      <h1>Privacy Policy</h1>
      <p><em>Last updated: 2026. Playin is designed to be private by architecture, not by promise.</em></p>

      <h2>What we store</h2>
      <p>
        Account data (email, display name, avatar, accent color), room data (rooms, memberships,
        chat history, playlists, read cursors), and media you upload. That is the whole list.
      </p>

      <h2>End-to-end encrypted media</h2>
      <p>
        Calls and peer-to-peer media travel over WebRTC with DTLS-SRTP — encrypted between
        devices by construction. In the default mesh topology the server never sees media
        plaintext. Premium Theater rooms relay through an SFU, which terminates encryption at
        the relay; the room badge always says which mode you are in.
      </p>

      <h2>What we do not do</h2>
      <p>
        No trackers, no analytics SDKs, no ad networks, no chat content filtering, no media
        scanning, no telemetry on what you watch. The only cookie Playin sets is the httpOnly
        authentication cookie — strictly necessary, so there is no consent banner circus.
      </p>

      <h2>Your rights (GDPR)</h2>
      <p>
        Settings → Your data gives you <strong>export</strong> (a complete JSON dump of your
        account) and <strong>deletion</strong> (account plus cascade, executed after a short
        grace period). Sessions can be revoked per-device or everywhere at once.
      </p>

      <h2>Self-hosted instances</h2>
      <p>
        Playin is open, self-hosted software. If you are using someone else’s instance, its
        operator is the data controller for your data.
      </p>
    </>
  );
}
