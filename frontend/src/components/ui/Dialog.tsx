import React from 'react';
import { AlertTriangle, HelpCircle, Info } from 'lucide-react';
import { Modal } from './Modal';
import { Button } from './Button';

type DialogTone = 'danger' | 'warning' | 'info';

const TONES: Record<DialogTone, { icon: React.ElementType; badge: string; confirm: 'primary' | 'danger' }> = {
  danger: { icon: AlertTriangle, badge: 'bg-destructive/10 text-destructive', confirm: 'danger' },
  warning: { icon: HelpCircle, badge: 'bg-warning/10 text-warning', confirm: 'primary' },
  info: { icon: Info, badge: 'bg-info/10 text-info', confirm: 'primary' },
};

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** Say plainly what will happen, including anything irreversible. */
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: DialogTone;
  isLoading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirmation dialog for destructive or irreversible actions — the replacement
 * for `window.confirm`, which cannot be styled and is blocked in some browsers.
 */
export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'danger',
  isLoading = false,
  onConfirm,
  onCancel,
}) => {
  const { icon: Icon, badge, confirm } = TONES[tone];

  return (
    <Modal
      open={open}
      onClose={isLoading ? () => {} : onCancel}
      size="sm"
      ariaLabel={title}
      // A destructive choice should be answered, not dismissed by a stray click.
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={isLoading}>
            {cancelLabel}
          </Button>
          <Button variant={confirm} onClick={onConfirm} isLoading={isLoading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex gap-4">
        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${badge}`}>
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 pt-0.5">
          <h2 className="text-md font-semibold text-foreground">{title}</h2>
          <div className="mt-1.5 text-sm text-muted">{message}</div>
        </div>
      </div>
    </Modal>
  );
};

export default ConfirmDialog;
