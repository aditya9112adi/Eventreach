
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
    e.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    e.type?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div className="relative w-full min-w-[240px]" ref={wrapperRef}>
      <div 
        className="flex items-center justify-between bg-surface border border-border text-foreground px-3 py-2 rounded-md cursor-pointer hover:border-accent/50 transition-colors"
        onClick={() => setIsOpen(!isOpen)}
      >
        {selectedEvent ? (
          <span className="truncate flex-1 text-sm font-medium">
            {selectedEvent.name}
          </span>
        ) : (
          <span className="truncate flex-1 text-sm text-foreground/50 flex items-center">
            <Search className="w-4 h-4 mr-2" />
            {placeholder}
          </span>
        )}
        
        <div className="flex items-center ml-2">
          {allowClear && selectedEvent && (
            <div 
              className="p-1 hover:bg-background rounded-md text-foreground/40 hover:text-foreground mr-1 transition-colors"
              onClick={(e) => { e.stopPropagation(); onChange(''); setSearchTerm(''); }}
            >
              <X className="w-3.5 h-3.5" />
            </div>
          )}
          <ChevronDown className="w-4 h-4 text-foreground/40" />
        </div>
      </div>

      {isOpen && (
        <div className="absolute z-50 w-full mt-1 bg-surface border border-border rounded-md shadow-glass-lg overflow-hidden flex flex-col max-h-[300px]">
          <div className="p-2 border-b border-border flex items-center bg-background/50">
            <Search className="w-4 h-4 text-foreground/40 mr-2" />
            <input
              type="text"
              className="w-full bg-transparent border-none focus:outline-none text-sm text-foreground placeholder:text-foreground/40"
              placeholder="Type to search events..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              autoFocus
            />
          </div>
          <div className="overflow-y-auto flex-1 p-1">
            {allowClear && (
              <div 
                className={"px-3 py-2 text-sm rounded cursor-pointer hover:bg-surfaceHover "}
                onClick={() => { onChange(''); setIsOpen(false); setSearchTerm(''); }}
              >
                All Events / Clear Selection
              </div>
            )}
            {filteredEvents.length === 0 ? (
              <div className="px-3 py-6 text-sm text-center text-foreground/50 flex flex-col items-center">
                <Search className="w-6 h-6 mb-2 opacity-20" />
                No events found matching "\\"
              </div>
            ) : (
              filteredEvents.map(evt => (
                <div 
                  key={evt._id}
                  className={"px-3 py-2 mt-1 text-sm rounded cursor-pointer hover:bg-surfaceHover "}
                  onClick={() => { onChange(evt._id); setIsOpen(false); setSearchTerm(''); }}
                >
                  <div className="font-medium truncate">{evt.name}</div>
                  <div className="text-xs opacity-70 flex justify-between mt-0.5 gap-2">
                    <span className="truncate">{evt.type}</span><span className="shrink-0">{evt.date}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}


