import { useEffect, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';

interface ConfirmDialogProps {
  message: string;
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Custom confirm dialog — replaces native confirm() which looks broken in Electron.
 * Renders inside the app with proper styling, keyboard support (Esc to cancel, Enter to confirm),
 * and focus management.
 */
export default function ConfirmDialog({
  message,
  detail,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      if (e.key === 'Enter') { e.preventDefault(); onConfirm(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onConfirm, onCancel]);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal confirm-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-dialog-body">
          <div className="row" style={{ gap: 10, marginBottom: 12 }}>
            {danger && <AlertTriangle size={18} style={{ color: 'var(--warn)', flexShrink: 0 }} />}
            <div>
              <div className="confirm-dialog-message">{message}</div>
              {detail && <div className="confirm-dialog-detail">{detail}</div>}
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn ghost" onClick={onCancel}>{cancelLabel}</button>
          <button
            ref={confirmRef}
            className={danger ? 'btn danger' : 'btn primary'}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
