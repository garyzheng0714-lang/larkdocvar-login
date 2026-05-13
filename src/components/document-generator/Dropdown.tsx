import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';

interface DropdownProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  align?: 'left' | 'right';
  width?: number;
  triggerRef: RefObject<HTMLElement | null>;
}

interface Pos {
  top: number;
  left: number;
  width: number;
}

const EDGE_GAP = 8;
const MIN_MENU_WIDTH = 120;

export function Dropdown({ open, onClose, children, align = 'left', width, triggerRef }: DropdownProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<Pos | null>(null);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    const availableW = Math.max(MIN_MENU_WIDTH, window.innerWidth - EDGE_GAP * 2);
    const menuW = Math.min(width || r.width, availableW);
    const rawLeft = align === 'right' ? r.right - menuW : r.left;
    const maxLeft = Math.max(EDGE_GAP, window.innerWidth - menuW - EDGE_GAP);
    const left = Math.min(Math.max(rawLeft, EDGE_GAP), maxLeft);
    setPos({ top: r.bottom + 4, left, width: menuW });
  }, [open, align, width, triggerRef]);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        ref.current &&
        !ref.current.contains(target) &&
        triggerRef.current &&
        !triggerRef.current.contains(target)
      ) {
        onClose();
      }
    };
    const onScroll = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const t = window.setTimeout(() => document.addEventListener('mousedown', h), 0);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    document.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('mousedown', h);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose, triggerRef]);

  if (!open || !pos) return null;
  return createPortal(
    <div
      ref={ref}
      className="dd-menu dd-menu-fixed"
      style={{ top: pos.top, left: pos.left, width: pos.width }}
    >
      {children}
    </div>,
    document.body,
  );
}
