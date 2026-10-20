import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Event } from '@eventreach/shared';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ArrowLeft } from 'lucide-react';
import api from '../../services/api';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { useLoader } from '../../components/ui/FullScreenLoader';
import { useToast } from '../../components/ui/Toast';
import { EventTypeField } from '../../components/ui/EventTypeField';
import { refineEventType, resolveEventType } from '../../utils/eventType';
import { applyOrganizerMobileInput, counterLabel, reconcileOrganizerMobileChange } from '../../utils/organizerMobile';

const LIMITS = {
  organizerName: 50,
  name: 20,
  venue: 50,
  description: 256,
};

const eventSchema = z.object({
  organizerName:    z.string().min(1, 'Event Organizer is required').max(LIMITS.organizerName, `Event Organizer max ${LIMITS.organizerName} characters`),
  organizerMobile:  z.string().regex(/^\d{10}$/, 'Mobile No must be exactly 10 digits'),
  eventName:        z.string().min(1, 'Event Name is required').max(LIMITS.name, `Event Name max ${LIMITS.name} characters`),
  // A choice from the shared list; "Other" requires customEventType. Both are
  // checked by refineEventType below, the same rules in Create and Edit.
  eventType:        z.string(),
  customEventType:  z.string().optional(),
  eventDate:        z.string().min(1, 'Event Date is required').regex(/^\d{4}-\d{2}-\d{2}$/, 'Event Date must be YYYY-MM-DD'),
  eventTime:        z.string().min(1, 'Event Time is required').regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Event Time must be a valid HH:MM'),
  eventVenue:       z.string().min(1, 'Event Venue is required').max(LIMITS.venue, `Event Venue max ${LIMITS.venue} characters`),
  eventDescription: z.string().max(LIMITS.description, `Event Description max ${LIMITS.description} characters`).optional(),
}).superRefine((data, ctx) => {
  refineEventType(data, ctx);
  if (data.eventDate) {
    const now = new Date();
    const todayStr = new Date(now.getTime() - (now.getTimezoneOffset() * 60000)).toISOString().split('T')[0];
    if (data.eventDate < todayStr) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Event Date cannot be in the past', path: ['eventDate'] });
    } else if (data.eventDate === todayStr && data.eventTime) {
      const currentHours = now.getHours().toString().padStart(2, '0');
      const currentMinutes = now.getMinutes().toString().padStart(2, '0');
      if (data.eventTime < `${currentHours}:${currentMinutes}`) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Event Time cannot be in the past', path: ['eventTime'] });
      }
    }
  }
});

type EventForm = z.infer<typeof eventSchema>;

/**
 * `limitAttempted` is given only by a field that warns on an attempt to go past
 * its limit (the organizer mobile number); every other field shows the warning
 * whenever it is full, as before.
 */
const CharCount = ({ value, max, limitAttempted }: { value: string | undefined; max: number; limitAttempted?: boolean }) => {
  const { text, atLimit } = counterLabel(value?.length ?? 0, max, limitAttempted);
  return (
    <p className={`mt-1 text-xs text-right ${atLimit ? 'text-destructive font-semibold' : 'text-foreground/40'}`}>
      {text}
    </p>
  );
};

/**
 * Creates a Main Event at /events/create, or a Sub-Event of the Main Event :id
 * at /events/:id/sub-events/new. A Sub-Event is an event with the same fields
 * and rules, so it is the same form; the parent comes from the route and is
 * sent only as the URL of the request, never as a form field.
 */
const EventCreate = () => {
  const navigate = useNavigate();
  const { id: parentId } = useParams();
  const isSubEvent = Boolean(parentId);
  const backTo = isSubEvent ? `/events/${parentId}` : '/events';
  const [error, setError] = useState('');
  const { showToast } = useToast();
  const { showLoader, showSuccess, showError } = useLoader();
  const [parent, setParent] = useState<Event | null>(null);
  const [parentError, setParentError] = useState('');

  const { register, handleSubmit, watch, setValue, getValues, formState: { errors, isSubmitting } } = useForm<EventForm>({
    resolver: zodResolver(eventSchema),
    // Nothing chosen yet: the dropdown shows "Select Event Type".
    defaultValues: { eventType: '', customEventType: '' },
  });

  // The organizer mobile number takes at most 10 digits, and warns only on an attempt to add an 11th.
  const organizerMobileField = register('organizerMobile');
  const [mobileLimitAttempted, setMobileLimitAttempted] = useState(false);

  // The Main Event: named in the heading, and its organizer offered as the
  // sub-event's (editable - a ceremony can have its own contact person).
  useEffect(() => {
    if (!parentId) return;
    let cancelled = false;
    api.get(`/events/${parentId}`)
      .then((res) => {
        if (cancelled) return;
        const main: Event = res.data;
        if (main.parentEventId) {
          setParentError('A sub-event cannot have sub-events of its own.');
        } else if (main.eventStatus !== 'Upcoming') {
          setParentError(`This event is ${main.eventStatus.toLowerCase()}. Sub-events can only be added to an upcoming event.`);
        }
        setParent(main);
        setValue('organizerName', main.organizerName || '');
        setValue('organizerMobile', main.organizerMobile || '');
      })
      .catch((err) => {
        if (!cancelled) setParentError(err.response?.data?.error || 'Failed to load the main event.');
      });
    return () => { cancelled = true; };
  }, [parentId, setValue]);

  const [wOrgName, wOrgMobile, wName, wType, wCustomType, wVenue, wDesc] = watch(['organizerName', 'organizerMobile', 'eventName', 'eventType', 'customEventType', 'eventVenue', 'eventDescription']);
  const selectedDate = watch('eventDate');
  const selectedTime = watch('eventTime');

  const now = new Date();
  const todayStr = new Date(now.getTime() - (now.getTimezoneOffset() * 60000)).toISOString().split('T')[0];

  let minTime: string | undefined;
  if (selectedDate === todayStr) {
    minTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
  }

  useEffect(() => {
    if (selectedDate === todayStr && selectedTime && minTime && selectedTime < minTime) {
      setValue('eventTime', minTime, { shouldValidate: true });
      showToast('warning', 'Past time selected. Automatically adjusted to current time.');
    } else if (selectedDate && selectedDate < todayStr) {
      setValue('eventDate', todayStr, { shouldValidate: true });
      showToast('warning', 'Past date selected. Automatically adjusted to today.');
    }
  }, [selectedDate, selectedTime, minTime, todayStr, setValue, showToast]);

  const onSubmit = async (form: EventForm) => {
    // eventType is the chosen option, or the type specified under Other.
    const { customEventType, ...fields } = form;
    const data = { ...fields, eventType: resolveEventType(form.eventType, customEventType) };
    showLoader(isSubEvent ? 'Creating sub-event...' : 'Creating event...');
    try {
      setError('');
      const response = isSubEvent
        ? await api.post(`/events/${parentId}/sub-events`, data)
        : await api.post('/events', data);
      await showSuccess(isSubEvent ? 'Sub-event created successfully!' : 'Event created successfully!');
      navigate(`/events/${response.data._id}`);
    } catch (err: any) {
      const errorMsg = err.response?.data?.error || (isSubEvent ? 'Failed to create sub-event' : 'Failed to create event');
      setError(errorMsg);
      await showError(errorMsg);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center space-x-4 mb-2 animate-fade-in">
        <button
          onClick={() => navigate(backTo)}
          aria-label={isSubEvent ? 'Back to the main event' : 'Back to events'}
          className="p-2 text-foreground/50 hover:text-foreground hover:bg-surfaceHover rounded-full transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div>
          <h2 className="text-3xl font-sans font-bold text-foreground uppercase tracking-wider">
            {isSubEvent ? 'Create Sub-Event' : 'Create Event'}
          </h2>
          {isSubEvent && parent && (
            <p className="text-sm text-foreground/50 mt-1">
              Under <span className="font-medium text-foreground/80">{parent.eventName}</span>
              {parent.eventId ? <span className="font-mono"> ({parent.eventId})</span> : null}. It starts with no members.
            </p>
          )}
        </div>
      </div>

      <div className="bg-surface rounded-xl border border-border overflow-hidden animate-fade-up stagger-1">
        <form onSubmit={handleSubmit(onSubmit)} className="p-6 md:p-8 space-y-6">
          {parentError && (
            <div role="alert" className="p-4 bg-destructive/10 border border-destructive/20 text-destructive rounded-md text-sm">
              {parentError}
            </div>
          )}
          {error && (
            <div className="p-4 bg-destructive/10 border border-destructive/20 text-destructive rounded-md text-sm">
              {error}
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <Input
                label="Event Organizer"
                placeholder="e.g. John Doe"
                maxLength={LIMITS.organizerName}
                {...register('organizerName')}
                error={errors.organizerName?.message}
              />
              <CharCount value={wOrgName} max={LIMITS.organizerName} />
            </div>
            <div>
              <Input
                label="Organizer Mobile Number"
                placeholder="e.g. 9876543210"
                inputMode="numeric"
                {...organizerMobileField}
                /* No native maxLength: it would stop the 11th digit before the page could see the
                   attempt, and cut a pasted number silently. A keystroke or paste that would go
                   past 10 digits is stopped here instead, so the digits already typed, and the
                   cursor, stay exactly as they were. */
                onKeyDown={(e) => {
                  if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
                  const input = e.currentTarget;
                  const result = applyOrganizerMobileInput(
                    { value: input.value, limitAttempted: mobileLimitAttempted },
                    { start: input.selectionStart ?? input.value.length, end: input.selectionEnd ?? input.value.length, text: e.key }
                  );
                  if (!result.accepted) e.preventDefault();
                  setMobileLimitAttempted(result.limitAttempted);
                }}
                onPaste={(e) => {
                  e.preventDefault();
                  const input = e.currentTarget;
                  const result = applyOrganizerMobileInput(
                    { value: input.value, limitAttempted: mobileLimitAttempted },
                    { start: input.selectionStart ?? input.value.length, end: input.selectionEnd ?? input.value.length, text: e.clipboardData.getData('text'), isPaste: true }
                  );
                  setMobileLimitAttempted(result.limitAttempted);
                  if (!result.accepted) return;
                  setValue('organizerMobile', result.value, { shouldValidate: true, shouldDirty: true });
                  input.setSelectionRange(result.caret, result.caret);
                }}
                // Input the key handler cannot see (a phone's on-screen keyboard): put the
                // previous digits and the cursor back instead of accepting an 11th digit.
                onChange={(e) => {
                  const input = e.currentTarget;
                  const result = reconcileOrganizerMobileChange(
                    { value: getValues('organizerMobile') ?? '', limitAttempted: mobileLimitAttempted },
                    input.value,
                    input.selectionStart ?? input.value.length
                  );
                  if (result.value !== input.value) {
                    input.value = result.value;
                    input.setSelectionRange(result.caret, result.caret);
                  }
                  organizerMobileField.onChange(e);
                  setMobileLimitAttempted(result.limitAttempted);
                }}
                error={errors.organizerMobile?.message}
              />
              <CharCount value={wOrgMobile} max={10} limitAttempted={mobileLimitAttempted} />
            </div>
            <div>
              <Input
                label="Event Name"
                placeholder={isSubEvent ? 'e.g. Haldi Ceremony' : 'e.g. Annual Tech Conference 2026'}
                maxLength={LIMITS.name}
                {...register('eventName')}
                error={errors.eventName?.message}
              />
              <CharCount value={wName} max={LIMITS.name} />
            </div>
            <EventTypeField
              select={register('eventType')}
              custom={register('customEventType')}
              selected={wType}
              customValue={wCustomType}
              selectError={errors.eventType?.message}
              customError={errors.customEventType?.message}
            />
            <Input
              label="Event Date"
              type="date"
              min={todayStr}
              {...register('eventDate')}
              error={errors.eventDate?.message}
            />
            <Input
              label="Event Time"
              type="time"
              min={minTime}
              {...register('eventTime')}
              error={errors.eventTime?.message}
            />
          </div>

          <div>
            <Input
              label="Event Venue"
              placeholder="e.g. Grand Hotel OR Zoom Link"
              maxLength={LIMITS.venue}
              {...register('eventVenue')}
              error={errors.eventVenue?.message}
            />
            <CharCount value={wVenue} max={LIMITS.venue} />
          </div>

          <div>
            <label className="block text-sm font-sans font-medium text-foreground/80 mb-2 uppercase tracking-wide">
              Event Description (Optional)
            </label>
            <textarea
              className="w-full rounded-md border border-border bg-surface/50 text-foreground p-3 text-sm focus:ring-2 focus:ring-white/20 outline-none min-h-[100px] resize-y transition-all duration-200"
              placeholder="Enter Event Description."
              maxLength={LIMITS.description}
              {...register('eventDescription')}
            ></textarea>
            <CharCount value={wDesc} max={LIMITS.description} />
            {errors.eventDescription && (
              <p className="mt-1 text-sm text-destructive">{errors.eventDescription.message}</p>
            )}
          </div>

          <div className="flex justify-end space-x-4 pt-4 border-t border-border">
            <Button type="button" variant="secondary" onClick={() => navigate(backTo)}>
              Cancel
            </Button>
            {/* isSubmitting disables the button while the request runs, so a
                double click cannot create the event twice. */}
            <Button type="submit" isLoading={isSubmitting} disabled={Boolean(parentError) || (isSubEvent && !parent)}>
              {isSubEvent ? 'Create Sub-Event' : 'Create Event'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default EventCreate;
