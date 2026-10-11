import type { UseFormRegisterReturn } from 'react-hook-form';
import { EVENT_TYPE_MAX_LENGTH, EVENT_TYPE_OPTIONS, OTHER_EVENT_TYPE } from '../../utils/eventType';

/**
 * The Event Type field of the Create and Edit event forms: a dropdown of the
 * shared options, and - when "Other" is chosen - a "Specify Event Type" box
 * whose text is what gets saved (see resolveEventType).
 *
 * The box is only hidden, never cleared, when another option is chosen, so
 * switching back to Other brings back what was typed. Validation of both
 * fields lives in the form's schema (refineEventType).
 *
 * Styled as Input is, so it sits in the forms' two-column grid like the
 * fields around it, in both themes.
 */

const FIELD_CLASS =
  'w-full rounded-md border bg-surface px-4 py-2.5 text-sm transition-all duration-200 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50';
const OK_CLASS =
  'border-border focus:ring-2 focus:ring-white/20 focus:border-white/40 text-foreground placeholder-foreground/30 hover:border-border/80';
const ERROR_CLASS =
  'border-destructive focus:border-destructive focus:ring-2 focus:ring-destructive text-destructive placeholder-destructive/50';

interface EventTypeFieldProps {
  select: UseFormRegisterReturn<'eventType'>;
  custom: UseFormRegisterReturn<'customEventType'>;
  /** The chosen option ('' while nothing is chosen). */
  selected: string | undefined;
  /** The text in the Specify box, for its character count. */
  customValue: string | undefined;
  selectError?: string;
  customError?: string;
}

export const EventTypeField = ({ select, custom, selected, customValue, selectError, customError }: EventTypeFieldProps) => {
  const isOther = selected === OTHER_EVENT_TYPE;
  const length = customValue?.length ?? 0;
  const atLimit = length >= EVENT_TYPE_MAX_LENGTH;

  return (
    <div className="w-full space-y-3">
      <div>
        <label htmlFor="eventType" className="block text-sm font-sans text-foreground/80 mb-2">
          Event Type
        </label>
        <select
          id="eventType"
          {...select}
          aria-invalid={Boolean(selectError)}
          className={`${FIELD_CLASS} ${selectError ? ERROR_CLASS : OK_CLASS} cursor-pointer`}
        >
          <option value="" disabled>
            Select Event Type
          </option>
          {EVENT_TYPE_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        {selectError && <p className="mt-1 text-sm text-red-600">{selectError}</p>}
      </div>

      {isOther && (
        <div>
          <label htmlFor="customEventType" className="block text-sm font-sans text-foreground/80 mb-2">
            Specify Event Type
          </label>
          <input
            id="customEventType"
            type="text"
            {...custom}
            placeholder="e.g. Product Launch"
            maxLength={EVENT_TYPE_MAX_LENGTH}
            autoComplete="off"
            aria-invalid={Boolean(customError)}
            className={`${FIELD_CLASS} ${customError ? ERROR_CLASS : OK_CLASS}`}
          />
          {customError && <p className="mt-1 text-sm text-red-600">{customError}</p>}
          <p className={`mt-1 text-xs text-right ${atLimit ? 'text-destructive font-semibold' : 'text-foreground/40'}`}>
            {length}/{EVENT_TYPE_MAX_LENGTH}{atLimit ? ' — limit reached' : ''}
          </p>
        </div>
      )}
    </div>
  );
};
