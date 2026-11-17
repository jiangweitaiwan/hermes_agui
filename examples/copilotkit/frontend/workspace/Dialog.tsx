import { useEffect, useRef, type ReactNode } from "react";
interface DialogProps { title: string; onClose: () => void; children: ReactNode }
export function Dialog({ title, onClose, children }: DialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return <dialog ref={dialog} aria-label={title} onCancel={event => { event.preventDefault(); onClose(); }}>
    {children}<button type="button" onClick={onClose}>關閉</button>
  </dialog>;
}
