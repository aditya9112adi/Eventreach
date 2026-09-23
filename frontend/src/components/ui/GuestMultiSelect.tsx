import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, Search, Users } from 'lucide-react';
import {
  filterGuests,
  guestSelectionLabel,
  selectAllGuests,
  toggleGuest,
  type GuestOption,
} from '../../utils/templateTest';

/**
 * Picks one or more guests of an event.
 *
 * Built on the same dropdown behaviour as EventSearch (click outside to close,
 * a search row at the top, a scrolling option list) with the one difference
 * that matters here: choosing an option toggles it and leaves the list open,
 * because the point is to pick several. Searching only narrows what is shown —
 * it never changes the selection.
 *
 * Selection state lives with the caller: this component owns nothing but the
 * open/closed state and the search term.
 */

const CHECKBOX_CLASS =
  'rounded border-border bg-background text-accent focus:ring-accent/20 cursor-pointer';

interface GuestMultiSelectProps {
  guests: GuestOption[];
  /** Selected guest ids. Treated as a set: order and duplicates do not matter. */
  value: string[];
  onChange: (ids: string[]) => void;
  isLoading?: boolean;
  /** Shown in place of the list when there are no guests at all. */
  emptyMessage?: string;
  disabled?: boolean;
  /** Ties the visible <label> to the trigger button. */
  id?: string;
}

export const GuestMultiSelect = ({
  guests,
  value,
  onChange,
  isLoading = false,
  emptyMessage = 'No guests available.',
  disabled = false,
  id,
}: GuestMultiSelectProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const selected = new Set(value);
  const visible = filterGuests(guests, searchTerm);
  const allVisibleSelected = visible.length > 0 && visible.every((guest) => selected.has(guest._id));

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setSearchTerm('');
      }
    };
    // Escape closes and returns focus to the trigger, so keyboard users are
    // never left inside a closed popover.
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
        setSearchTerm('');
        triggerRef.current?.focus();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  // Toggling leaves the dropdown open on purpose: the point of this control is
  // picking several guests, so it never closes itself on a choice.
  const toggle = (guestId: string) => onChange(toggleGuest(value, guestId));
  const selectAll = () => onChange(selectAllGuests(value, visible));
  const clearAll = () => onChange([]);

  return (
    <div className="relative w-full" ref={wrapperRef}>
      <button
        id={id}
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="true"
        aria-expanded={isOpen}
        onClick={() => {
          setIsOpen((open) => !open);
          setSearchTerm('');
        }}
        className={`flex w-full items-center justify-between rounded-md border bg-surface px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
          isOpen ? 'border-accent' : 'border-border hover:border-accent/50'
        }`}
      >
        <span
          className={`truncate text-sm ${value.length > 0 ? 'text-foreground font-medium' : 'text-foreground/50'}`}
        >
          {guestSelectionLabel(value.length)}
        </span>
        <ChevronDown
          className={`ml-2 h-4 w-4 shrink-0 text-foreground/40 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: -10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -10 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            role="group"
            aria-label="Guests"
            className="absolute z-50 mt-1 flex max-h-[320px] w-full origin-top flex-col overflow-hidden rounded-md border border-border bg-surface shadow-glass-lg"
          >
            <div className="flex items-center gap-2 border-b border-border bg-background/30 px-3 py-2">
              <Search className="h-4 w-4 shrink-0 text-foreground/40" />
              <input
                type="text"
                className="w-full border-none bg-transparent text-sm text-foreground outline-none placeholder:text-foreground/40"
                placeholder="Search guests..."
                aria-label="Search guests"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                autoFocus
              />
            </div>

            <div className="flex items-center justify-between border-b border-border/40 px-3 py-1.5 text-xs">
              <button
                type="button"
                onClick={selectAll}
                disabled={visible.length === 0 || allVisibleSelected}
                className="rounded px-1.5 py-1 text-accent transition-colors hover:bg-surfaceHover disabled:cursor-not-allowed disabled:text-foreground/30 disabled:hover:bg-transparent"
              >
                Select All
              </button>
              <span className="text-foreground/40">{value.length} selected</span>
              <button
                type="button"
                onClick={clearAll}
                disabled={value.length === 0}
                className="rounded px-1.5 py-1 text-foreground/60 transition-colors hover:bg-surfaceHover hover:text-foreground disabled:cursor-not-allowed disabled:text-foreground/30 disabled:hover:bg-transparent"
              >
                Clear All
              </button>
            </div>

            <div className="flex-1 overflow-y-auto">
              {isLoading ? (
                <p className="px-4 py-6 text-center text-sm text-foreground/50">Loading guests...</p>
              ) : guests.length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-foreground/50">{emptyMessage}</p>
              ) : visible.length === 0 ? (
                <div className="flex flex-col items-center gap-2 px-4 py-6 text-center text-sm text-foreground/50">
                  <Users className="h-5 w-5 opacity-20" />
                  No guests match "{searchTerm}"
                </div>
              ) : (
                visible.map((guest) => {
                  const checked = selected.has(guest._id);
                  return (
                    <label
                      key={guest._id}
                      className={`flex cursor-pointer items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surfaceHover ${
                        checked ? 'bg-accent/10' : ''
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(guest._id)}
                        className={CHECKBOX_CLASS}
                      />
                      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                        {guest.fullName}
                        <span className="text-foreground/50"> — {guest.phoneNumber}</span>
                      </span>
                    </label>
                  );
                })
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
