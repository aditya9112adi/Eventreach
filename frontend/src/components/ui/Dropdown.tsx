import React, { useEffect, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';

export interface DropdownItem {
  label: string;
  icon?: LucideIcon;
  onSelect: () => void;
  /** Renders the row in red — use for destructive entries. */
  destructive?: boolean;
  disabled?: boolean;
  /** Draws a divider above this row. */
  separated?: boolean;
}

interface DropdownProps {
  /** The clickable element. It receives no props; the wrapper handles events. */
  trigger: React.ReactNode;
  items: DropdownItem[];
  align?: 'left' | 'right';
  /** Optional heading rendered at the top of the menu. */
  header?: React.ReactNode;
  className?: string;
  menuClassName?: string;
}

/**
 * Menu anchored to a trigger. Closes on outside click, on Escape, and after a
 * selection; the trigger keeps focus so keyboard users are not dropped at the
 * top of the page.
 */
export const Dropdown: React.FC<DropdownProps> = ({
  trigger,
  items,
  align = 'right',
  header,
  className = '',
  menuClassName = '',
}) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        {trigger}
      </button>

      {open && (
        <div
          role="menu"
          className={[
            'absolute z-50 mt-1.5 min-w-[11rem] overflow-hidden rounded-lg border border-border',
            'bg-surface p-1 shadow-lg animate-scale-in origin-top',
            align === 'right' ? 'right-0' : 'left-0',
            menuClassName,
          ].join(' ')}
        >
          {header && <div className="px-3 py-2">{header}</div>}

          {items.map((item, index) => {
            const Icon = item.icon;
            return (
              <React.Fragment key={`${item.label}-${index}`}>
                {item.separated && <div className="my-1 h-px bg-border" />}
                <button
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  onClick={() => {
                    setOpen(false);
                    item.onSelect();
                  }}
                  className={[
                    'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm',
                    'transition-colors duration-micro disabled:pointer-events-none disabled:opacity-50',
                    item.destructive
                      ? 'text-destructive hover:bg-destructive/10'
                      : 'text-foreground hover:bg-surfaceHover',
                  ].join(' ')}
                >
                  {Icon && <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />}
                  {item.label}
                </button>
              </React.Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default Dropdown;
