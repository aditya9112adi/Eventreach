import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ArrowLeft, ShieldAlert } from 'lucide-react';
import api from '../../services/api';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { useLoader } from '../../components/ui/FullScreenLoader';
import { useToast } from '../../components/ui/Toast';

const LIMITS = {
  organizerName: 50,
  name: 20,
  type: 20,
  venue: 50,
  description: 256,
};

const eventSchema = z.object({
  organizerName:    z.string().min(1, 'Event Organizer is required').max(LIMITS.organizerName, `Event Organizer max ${LIMITS.organizerName} characters`),
  organizerMobile:  z.string().regex(/^\d{10}$/, 'Mobile No must be exactly 10 digits'),
  eventName:        z.string().min(1, 'Event Name is required').max(LIMITS.name, `Event Name max ${LIMITS.name} characters`),
  eventType:        z.string().min(1, 'Event Type is required').max(LIMITS.type, `Event Type max ${LIMITS.type} characters`),
  eventDate:        z.string().min(1, 'Event Date is required'),
  eventTime:        z.string().min(1, 'Event Time is required'),
  eventVenue:       z.string().min(1, 'Event Venue is required').max(LIMITS.venue, `Event Venue max ${LIMITS.venue} characters`),
  eventDescription: z.string().max(LIMITS.description, `Event Description max ${LIMITS.description} characters`).optional(),
}).superRefine((data, ctx) => {
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

const CharCount = ({ value, max }: { value: string | undefined; max: number }) => {
  const len = value?.length ?? 0;
  const atLimit = len >= max;
  return (
    <p className={`mt-1 text-xs text-right ${atLimit ? 'text-destructive font-semibold' : 'text-foreground/40'}`}>
      {len}/{max}{atLimit ? ' — limit reached' : ''}
    </p>
  );
};

const EventEdit = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const { showToast } = useToast();
  const { showLoader, showSuccess, showError } = useLoader();
  const [isLoading, setIsLoading] = useState(true);
  const [accessDenied, setAccessDenied] = useState(false);

  const { register, handleSubmit, watch, setValue, reset, formState: { errors, isSubmitting } } = useForm<EventForm>({
    resolver: zodResolver(eventSchema),
  });

  const [wOrgName, wOrgMobile, wName, wType, wVenue, wDesc] = watch(['organizerName', 'organizerMobile', 'eventName', 'eventType', 'eventVenue', 'eventDescription']);
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

  useEffect(() => {
    const fetchEvent = async () => {
      setIsLoading(true);
      try {
        const response = await api.get(`/events/${id}`);
        reset({
          organizerName:    response.data.organizerName || '',
          organizerMobile:  response.data.organizerMobile || '',
          eventName:        response.data.eventName || '',
          eventType:        response.data.eventType || '',
          eventDate:        response.data.eventDate || '',
          eventTime:        response.data.eventTime || '',
          eventVenue:       response.data.eventVenue || '',
          eventDescription: response.data.eventDescription || '',
        });
      } catch (err: any) {
        if (err.response?.status === 403) {
          setAccessDenied(true);
        } else {
          showError('Failed to load event details');
          navigate('/events');
        }
      } finally {
        setIsLoading(false);
      }
    };
    fetchEvent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, reset, navigate]);

  const onSubmit = async (data: EventForm) => {
    showLoader('Updating event...');
    try {
      setError('');
      await api.put(`/events/${id}`, data);
      await showSuccess('Event updated successfully!');
      navigate(`/events/${id}`);
    } catch (err: any) {
      const errorMsg = err.response?.data?.error || 'Failed to update event';
      setError(errorMsg);
      await showError(errorMsg);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent"></div>
      </div>
    );
  }

  if (accessDenied) {
    return (
      <div className="max-w-md mx-auto my-16 p-8 text-center bg-surface border border-border rounded-xl shadow-2xl space-y-4 animate-scale-in">
        <div className="w-16 h-16 bg-red-500/10 text-red-500 rounded-full flex items-center justify-center mx-auto">
          <ShieldAlert className="w-8 h-8" />
        </div>
        <h2 className="text-2xl font-bold text-foreground">Access Denied</h2>
        <p className="text-sm text-foreground/60 leading-relaxed">
          You do not have access to edit this event.
        </p>
        <div className="pt-2">
          <Button onClick={() => navigate('/events')}>Back to My Events</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center space-x-4 mb-2 animate-fade-in">
        <button
          onClick={() => navigate(`/events/${id}`)}
          className="p-2 text-foreground/50 hover:text-foreground hover:bg-surfaceHover rounded-full transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h2 className="text-3xl font-sans font-bold text-foreground uppercase tracking-wider">Edit Event</h2>
      </div>

      <div className="bg-surface rounded-xl border border-border overflow-hidden animate-fade-up stagger-1">
        <form onSubmit={handleSubmit(onSubmit)} className="p-6 md:p-8 space-y-6">
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
                label="Mobile No"
                placeholder="e.g. 9876543210"
                maxLength={10}
                {...register('organizerMobile')}
                error={errors.organizerMobile?.message}
              />
              <CharCount value={wOrgMobile} max={10} />
            </div>
            <div>
              <Input
                label="Event Name"
                placeholder="e.g. Annual Tech Conference 2026"
                maxLength={LIMITS.name}
                {...register('eventName')}
                error={errors.eventName?.message}
              />
              <CharCount value={wName} max={LIMITS.name} />
            </div>
            <div>
              <Input
                label="Event Type"
                placeholder="e.g. Conference, Webinar, Wedding"
                maxLength={LIMITS.type}
                {...register('eventType')}
                error={errors.eventType?.message}
              />
              <CharCount value={wType} max={LIMITS.type} />
            </div>
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
            <Button type="button" variant="secondary" onClick={() => navigate(`/events/${id}`)}>
              Cancel
            </Button>
            <Button type="submit" isLoading={isSubmitting}>
              Update Event
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default EventEdit;
