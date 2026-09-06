import { useState, useRef, useEffect } from 'react';
import { Search, ChevronDown, X } from 'lucide-react';
import type { Event } from '@eventreach/shared';
import { formatDate } from '../../utils/datetime';

interface EventSearchProps {
  events: Event[];
  value: string;
  onChange: (eventId: string) => void;
  placeholder?: string;
  allowClear?: boolean;
}

export const EventSearch = ({
  events,
  value,
  onChange,
  placeholder = 'Search events…',
  allowClear = true,
}: EventSearchProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const wrapperRef = useRef<HTMLDivElement>(null);

  const selectedEvent = events.find((e) => e._id === value);

  const filteredEvents = events
    .filter(
      (e) =>
        e.eventName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        e.eventType?.toLowerCase().includes(searchTerm.toLowerCase())
    )
    .slice(0, 50);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setSearchTerm('');
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Escape closes the list without changing the selection.
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
        setSearchTerm('');
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen]);

  return (
    <div className="relative w-full" ref={wrapperRef}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        onClick={() => {
          setIsOpen(!isOpen);
          if (!isOpen) setSearchTerm('');
        }}
        className={[
          'flex h-9 w-full items-center justify-between rounded-md border bg-surface px-3',
          'transition-[border-color,box-shadow] duration-control ease-out-expo',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25',
          isOpen ? 'border-primary ring-2 ring-primary/25' : 'border-input hover:border-muted/60',
        ].join(' ')}
      >
        <span
          className={`flex-1 truncate text-left text-sm ${
            selectedEvent ? 'font-medium text-foreground' : 'text-muted'
          }`}
        >
          {selectedEvent ? selectedEvent.eventName : placeholder}
        </span>

        <span className="ml-2 flex shrink-0 items-center gap-1">
          {allowClear && selectedEvent && (
            <span
              role="button"
              tabIndex={0}
              aria-label="Clear selection"
              className="rounded p-0.5 text-muted transition-colors duration-micro hover:bg-surfaceHover hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation();
                onChange('');
                setSearchTerm('');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  e.stopPropagation();
                  onChange('');
                  setSearchTerm('');
                }
              }}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
          )}
          <ChevronDown
            className={`h-4 w-4 text-muted transition-transform duration-control ${
              isOpen ? 'rotate-180' : ''
            }`}
            aria-hidden="true"
          />
        </span>
      </button>

      {isOpen && (
        <div
          role="listbox"
          className="absolute z-50 mt-1.5 flex max-h-80 w-full origin-top flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-lg animate-scale-in"
        >
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Search className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
            <input
              type="text"
              className="w-full border-none bg-transparent text-sm text-foreground placeholder:text-muted focus:outline-none"
              placeholder="Type to search events…"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              autoFocus
            />
          </div>

          <div className="flex-1 overflow-y-auto p-1">
            {allowClear && (
              <button
                type="button"
                className="w-full rounded-md px-3 py-2 text-left text-sm text-muted transition-colors duration-micro hover:bg-surfaceHover"
                onClick={() => {
                  onChange('');
                  setIsOpen(false);
                  setSearchTerm('');
                }}
              >
                All events
              </button>
            )}

            {filteredEvents.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-sm text-muted">
                <Search className="h-5 w-5 opacity-40" aria-hidden="true" />
                No events found
              </div>
            ) : (
              filteredEvents.map((evt) => (
                <button
                  key={evt._id}
                  type="button"
                  role="option"
                  aria-selected={value === evt._id}
                  className={[
                    'flex w-full items-start justify-between gap-4 rounded-md px-3 py-2.5 text-left',
                    'transition-colors duration-micro hover:bg-surfaceHover',
                    value === evt._id ? 'bg-primary/10' : '',
                  ].join(' ')}
                  onClick={() => {
                    onChange(evt._id);
                    setIsOpen(false);
                    setSearchTerm('');
                  }}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {evt.eventName}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-muted">{evt.eventType}</span>
                  </span>
                  <span className="mt-0.5 shrink-0 text-xs text-muted">
                    {formatDate(evt.eventDate)}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};
