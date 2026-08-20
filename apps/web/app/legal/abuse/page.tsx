import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Abuse & DMCA' };

export default function AbusePage() {
  return (
    <>
      <h1>Abuse &amp; DMCA</h1>
      <p><em>How to report abuse or copyright infringement on this instance.</em></p>

      <h2>Reporting content</h2>
      <p>
        Every message, user, room, and upload can be reported from inside the app
        (<strong>Message → Report</strong>, member list, room menu). Reports go to the instance
        operator with the content reference and your reason.
      </p>

      <h2>DMCA takedowns</h2>
      <p>
        If you believe content hosted on this instance infringes your copyright, send a notice
        including: (1) identification of the copyrighted work, (2) the location of the
        infringing material on this instance, (3) your contact details, and (4) a good-faith
        statement. Contact: the abuse address published by this instance’s operator
        (self-hosted deployments configure their own contact).
      </p>

      <h2>What happens next</h2>
      <p>
        Operators can remove reported content and ban accounts. We do not proactively scan
        private rooms — moderation is report-driven.
      </p>

      <h2>Repeat infringers</h2>
      <p>
        Accounts that repeatedly draw valid takedown notices are suspended, and their active
        sessions revoked everywhere.
      </p>
    </>
  );
}
