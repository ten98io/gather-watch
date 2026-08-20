'use client';

/**
 * The one reason-and-send surface behind every Report control — the chat
 * message menu, the member list, and the room menu. app/legal/abuse names
 * those three by hand as the way to reach the operator, so they must all
 * exist and they must all file the same shape of report.
 *
 * POST /report takes ANY verified identity, guests included, and applies no
 * room or role gate: the mailbox is how someone with no power in a room says
 * something is wrong there. So this carries no permission check of its own —
 * callers decide what is reportable, never who may report it.
 */
import { useState } from 'react';
import type { ReportTarget } from '@gather/contracts';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { describeError } from '@/lib/describe-error';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';

/** ReportBody.reason's own ceiling — the field must not out-type the contract. */
const REASON_MAX = 2000;

export function ReportDialog({
  target,
  subject,
  open,
  onOpenChange,
}: {
  target: ReportTarget;
  /** What is being reported, as it reads after the word "Report". */
  subject: string;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const send = async (): Promise<void> => {
    const trimmed = reason.trim();
    if (trimmed.length === 0) return;
    setBusy(true);
    try {
      await api.reports.create({ target, reason: trimmed });
      // The report is a mailbox row, not an action: promising a takedown here
      // would be a promise this app cannot keep.
      toast.success('Report sent to the operator');
      setReason('');
      onOpenChange(false);
    } catch (err) {
      toast.error(describeError(err, 'Couldn’t send that report'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-label={`Report ${subject}`}>
        <DialogTitle>Report {subject}</DialogTitle>
        <DialogDescription>
          This goes to whoever runs this instance, with a reference to the content and
          the reason you give. Nobody in the room is told.
        </DialogDescription>

        <form
          className="mt-4 flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <textarea
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
            }}
            rows={4}
            maxLength={REASON_MAX}
            placeholder="What is wrong with it?"
            aria-label="Why are you reporting this?"
            // Deliberately the same two steps as <Input> — one background
            // step and one hairline. A reason box is a field, not a surface.
            className={cn(
              'w-full resize-none rounded-ctl border border-hairline bg-surface-2 px-3 py-2',
              'text-body text-hi placeholder:text-low',
            )}
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={busy || reason.trim().length === 0}>
              Send report
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
