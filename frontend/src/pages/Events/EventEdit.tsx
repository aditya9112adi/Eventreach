import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ArrowLeft } from 'lucide-react';
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
  organizerName: z.string().min(1, 'Organizer name is required').max(LIMITS.organizerName, `Organizer name must be at most ${LIMITS.organizerName} characters`),
  organizerMobile: z.string().regex(/^\d{10}$/, 'Mobile number must be exactly 10 digits'),
  name: z.string().min(1, 'Event name is required').max(LIMITS.name, `Event name must be at most ${LIMITS.name} characters`),
  type: z.string().min(1, 'Event type is required').max(LIMITS.type, `Event type must be at most ${LIMITS.type} characters`),
  date: z.string().min(1, 'Date is required'),
  time: z.string().min(1, 'Time is required'),
  venue: z.string().min(1, 'Venue is required').max(LIMITS.venue, `Venue must be at most ${LIMITS.venue} characters`),
  description: z.string().max(LIMITS.description, `Description must be at most ${LIMITS.description} characters`).optional(),
}).superRefine((data, ctx) => {
  if (data.date) {
    const now = new Date();
    const todayStr = new Date(now.getTime() - (now.getTimezoneOffset() * 60000)).toISOString().split('T')[0];
    if (data.date < todayStr) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Date cannot be in the past', path: ['date'] });
    } else if (data.date === todayStr && data.time) {
      const currentHours = now.getHours().toString().padStart(2, '0');
      const currentMinutes = now.getMinutes().toString().padStart(2, '0');
      if (data.time < `${currentHours}:${currentMinutes}`) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Time cannot be in the past', path: ['time'] });
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

  const { register, handleSubmit, watch, reset, formState: { errors, isSubmitting } } = useForm<EventForm>({
    resolver: zodResolver(eventSchema),
  });

  const [wOrgName, wOrgMobile, wName, wType, wVenue, wDesc] = watch(['organizerName', 'organizerMobile', 'name', 'type', 'venue', 'description']);

  useEffect(() => {
    const fetchEvent = async () => {
      setIsLoading(true);
      try {
        const response = await api.get(`/events/${id}`);
        reset({
          organizerName: response.data.organizerName || '',
          organizerMobile: response.data.organizerMobile || '',
          name: response.data.name || '',
          type: response.data.type || '',
          date: response.data.date || '',
          time: response.data.time || '',
          venue: response.data.venue || '',
          description: response.data.description || '',
        });
      } catch (err) {
        showError('Failed to load event details');
        navigate('/events');
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

  const now = new Date();
  const todayStr = new Date(now.getTime() - (now.getTimezoneOffset() * 60000)).toISOString().split('T')[0];

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
                label="Organizer Mobile Number"
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
                {...register('name')}
                error={errors.name?.message}
              />
              <CharCount value={wName} max={LIMITS.name} />
            </div>
            <div>
              <Input
                label="Event Type"
                placeholder="e.g. Conference, Webinar, Wedding"
                maxLength={LIMITS.type}
                {...register('type')}
                error={errors.type?.message}
              />
              <CharCount value={wType} max={LIMITS.type} />
            </div>
            <Input
              label="Event Date"
              type="date"
              min={todayStr}
              {...register('date')}
              error={errors.date?.message}
            />
            <Input
              label="Event Time"
              type="time"
              {...register('time')}
              error={errors.time?.message}
            />
          </div>

          <div>
            <Input
              label="Event Venue"
              placeholder="e.g. Grand Hotel OR Zoom Link"
              maxLength={LIMITS.venue}
              {...register('venue')}
              error={errors.venue?.message}
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
              {...register('description')}
            ></textarea>
            <CharCount value={wDesc} max={LIMITS.description} />
            {errors.description && (
              <p className="mt-1 text-sm text-destructive">{errors.description.message}</p>
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
