
import { useState, useRef, useEffect } from 'react';
import { Search, ChevronDown, X } from 'lucide-react';
import type { Event } from '@eventreach/shared';

interface EventSearchProps {
  events: Event[];
  value: string;
  onChange: (eventId: string) => void;
  placeholder?: string;
  allowClear?: boolean;
}

export const EventSearch = ({ events, value, onChange, placeholder = 'Search events...', allowClear = true }: EventSearchProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const wrapperRef = useRef<HTMLDivElement>(null);

  const selectedEvent = events.find(e => e._id === value);

  const filteredEvents = events.filter(e =>
    e.eventName.toLowerCase().includes(searchTerm.toLowerCase()) ||
    e.eventType?.toLowerCase().includes(searchTerm.toLowerCase())
  ).slice(0, 50);

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

  return (
    <div className="relative w-full min-w-[240px]" ref={wrapperRef}>
      {/* Trigger button */}
      <div
        className={`flex items-center justify-between bg-surface border text-foreground px-3 py-2 rounded-md cursor-pointer transition-colors ${
          isOpen ? 'border-accent' : 'border-border hover:border-accent/50'
        }`}
        onClick={() => { setIsOpen(!isOpen); if (!isOpen) setSearchTerm(''); }}
      >
        {selectedEvent ? (
          <span className="truncate flex-1 text-sm font-medium text-foreground">
            {selectedEvent.eventName}
          </span>
        ) : (
          <span className="truncate flex-1 text-sm text-foreground/50">
            {placeholder}
          </span>
        )}

        <div className="flex items-center ml-2 gap-1 shrink-0">
          {allowClear && selectedEvent && (
            <div
              className="p-1 hover:bg-background rounded-md text-foreground/40 hover:text-foreground transition-colors"
              onClick={(e) => { e.stopPropagation(); onChange(''); setSearchTerm(''); }}
            >
              <X className="w-3.5 h-3.5" />
            </div>
          )}
          <ChevronDown className={`w-4 h-4 text-foreground/40 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
        </div>
      </div>

      {/* Dropdown */}
      {isOpen && (
        <div className="absolute z-50 w-full mt-1 bg-surface border border-border rounded-md shadow-glass-lg overflow-hidden flex flex-col max-h-[320px]">
          {/* Search input row */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-background/30">
            <Search className="w-4 h-4 text-foreground/40 shrink-0" />
            <input
              type="text"
              className="w-full bg-transparent border-none focus:outline-none text-sm text-foreground placeholder:text-foreground/40"
              placeholder="Type to search events..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              autoFocus
            />
          </div>

          {/* Options list */}
          <div className="overflow-y-auto flex-1">
            {allowClear && (
              <div
                className="px-4 py-2.5 text-sm text-foreground/50 cursor-pointer hover:bg-surfaceHover transition-colors border-b border-border/40"
                onClick={() => { onChange(''); setIsOpen(false); setSearchTerm(''); }}
              >
                All Events / Clear Selection
              </div>
            )}

            {filteredEvents.length === 0 ? (
              <div className="px-4 py-6 text-sm text-center text-foreground/50 flex flex-col items-center gap-2">
                <Search className="w-5 h-5 opacity-20" />
                No events found
              </div>
            ) : (
              filteredEvents.map(evt => (
                <div
                  key={evt._id}
                  className={`px-4 py-3 cursor-pointer hover:bg-surfaceHover transition-colors flex items-start justify-between gap-4 ${
                    value === evt._id ? 'bg-accent/10' : ''
                  }`}
                  onClick={() => { onChange(evt._id); setIsOpen(false); setSearchTerm(''); }}
                >
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-foreground truncate">{evt.eventName}</p>
                    <p className="text-xs text-foreground/50 mt-0.5 truncate">{evt.eventType}</p>
                  </div>
                  <span className="text-xs text-foreground/50 shrink-0 mt-0.5">{evt.eventDate}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};
