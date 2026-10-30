import { X } from "lucide-react";
import { ReactNode, useEffect, useRef } from "react";
import { t } from "@/lib/i18n";

/**
 * A modal window on the native <dialog>: the browser keeps focus inside it, Escape closes it, and the page behind is
 * inert. A click on the backdrop closes it too.
 */
export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);
  return <dialog ref={dialog} className="modal" aria-label={title} onClose={onClose} onClick={event => { if (event.target === dialog.current) onClose(); }}>
    <div className="modal-body">
      <div className="modal-heading"><h3>{title}</h3><button type="button" className="icon-button" onClick={onClose} aria-label={t("Close")}><X /></button></div>
      {children}
    </div>
  </dialog>;
}
