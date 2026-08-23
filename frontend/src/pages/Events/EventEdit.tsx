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

const eventSchema = z.object({
  organizerName: z.string().min(1, 'Organizer name is required'),
  organizerMobile: z.string().min(1, 'Organizer mobile is required'),
  name: z.string().min(1, 'Event name is required'),
  type: z.string().min(1, 'Event type is required'),
  date: z.string().min(1, 'Date is required'),
  time: z.string().min(1, 'Time is required'),
  venue: z.string().min(1, 'Venue is required'),
  description: z.string().optional(),
});

type EventForm = z.infer<typeof eventSchema>;

const EventEdit = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const { showToast } = useToast();
  const { showLoader, showSuccess, showError } = useLoader();
  
  const [isLoading, setIsLoading] = useState(true);
  
  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<EventForm>({
    resolver: zodResolver(eventSchema),
  });

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
            <Input
              label="Event Organizer"
              placeholder="e.g. John Doe"
              {...register('organizerName')}
              error={errors.organizerName?.message}
            />
            <Input
              label="Organizer Mobile Number"
              placeholder="e.g. +1234567890"
              {...register('organizerMobile')}
              error={errors.organizerMobile?.message}
            />
            <Input
              label="Event Name"
              placeholder="e.g. Annual Tech Conference 2026"
              {...register('name')}
              error={errors.name?.message}
            />
            <Input
              label="Event Type"
              placeholder="e.g. Conference, Webinar, Wedding"
              {...register('type')}
              error={errors.type?.message}
            />
            <Input
              label="Date"
              type="date"
              {...register('date')}
              error={errors.date?.message}
            />
            <Input
              label="Time"
              type="time"
              {...register('time')}
              error={errors.time?.message}
            />
          </div>

          <Input
            label="Venue / Location"
            placeholder="e.g. Grand Hotel OR Zoom Link"
            {...register('venue')}
            error={errors.venue?.message}
          />

          <div>
            <label className="block text-sm font-sans font-medium text-foreground/80 mb-2 uppercase tracking-wide">
              Description (Optional)
            </label>
            <textarea
              className="w-full rounded-md border border-border bg-surface/50 text-foreground p-3 text-sm focus:ring-2 focus:ring-white/20 outline-none min-h-[100px] resize-y transition-all duration-200"
              placeholder="Provide a brief description of the event..."
              {...register('description')}
            ></textarea>
            {errors.description && (
              <p className="mt-1 text-sm text-destructive">{errors.description.message}</p>
            )}
          </div>

          <div className="flex justify-end space-x-4 pt-4 border-t border-border">
            <Button 
              type="button" 
              variant="secondary" 
              onClick={() => navigate(`/events/${id}`)}
            >
              Cancel
            </Button>
            <Button 
              type="submit" 
              isLoading={isSubmitting}
            >
              Update Event
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default EventEdit;
