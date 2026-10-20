import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { XCircle } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { Event } from '@eventreach/shared';
import { COUNTRY_OPTIONS, DEFAULT_COUNTRY_CODE, INDIA_MOBILE_DIGITS, indianSubscriberLength } from '@eventreach/shared';
import api from '../../services/api';
import { Button } from './Button';
import { Input } from './Input';
import { useToast } from './Toast';
import { contactErrorMessage } from '../../utils/contactErrors';
import { GUEST_EMAIL_MAX, GUEST_NAME_MAX, guestSchema, type GuestForm } from '../../utils/guestForm';
import { insertMobileText, limitMobileTyping } from '../../utils/mobileDigits';

/**
 * Adds ONE guest to a Sub-Event: the same form, rules and wording as "Add Guest Manually" on the
 * Contacts page, posting to the same endpoint (POST /contacts) with the Sub-Event's id. The
 * server makes the guest the Sub-Event's own and puts it on that Sub-Event's list; the Main Event
 * and every other Sub-Event are untouched.
 */

interface AddGuestDialogProps {
  subEvent: Pick<Event, '_id' | 'eventName'>;
  open: boolean;
  onClose: () => void;
  /** Called once the server has confirmed the guest, so the list can refresh. */
  onAdded: () => void;
}

const CharCount = ({ value, max, warnAtMax = true }: { value: string | number | undefined; max: number; warnAtMax?: boolean }) => {
  const len = typeof value === 'number' ? value : value?.length ?? 0;
  const warn = len >= max && warnAtMax;
  return (
    <p className={`mt-1 text-xs text-right ${warn ? 'text-destructive font-semibold' : 'text-foreground/40'}`}>
      {len}/{max}{warn ? ' — limit reached' : ''}
    </p>
  );
};

const EMPTY: GuestForm = { countryCode: DEFAULT_COUNTRY_CODE, fullName: '', phoneNumber: '', email: '' };

export const AddGuestDialog = ({ subEvent, open, onClose, onAdded }: AddGuestDialogProps) => {
  const { showToast } = useToast();
  const { register, handleSubmit, reset, watch, setValue, getValues, formState: { errors, isSubmitting } } = useForm<GuestForm>({
    resolver: zodResolver(guestSchema),
    defaultValues: EMPTY,
  });
  const [wFullName, wPhone, wEmail] = watch(['fullName', 'phoneNumber', 'email']);
  const phoneField = register('phoneNumber');
  const [phoneHint, setPhoneHint] = useState<string | null>(null);
  const [error, setError] = useState('');
  // Set synchronously, so Enter pressed twice cannot send the same guest twice.
  const inFlight = useRef(false);

  // A fresh, empty form every time it opens (and for every sub-event).
  useEffect(() => {
    if (!open) return;
    reset(EMPTY);
    setError('');
    setPhoneHint(null);
  }, [open, subEvent._id, reset]);

  if (!open) return null;

  const close = () => {
    reset(EMPTY);
    onClose();
  };

  const onSubmit = async (data: GuestForm) => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      setError('');
      await api.post('/contacts', { ...data, eventId: subEvent._id });
      // Only now, with the server's confirmation: refresh, close, clear, announce.
      onAdded();
      close();
      showToast('success', 'Guest added successfully');
    } catch (err: any) {
      // The dialog stays open with everything typed so far.
      setError(contactErrorMessage(err, 'add'));
    } finally {
      inFlight.current = false;
    }
  };

  return createPortal(
    <div className="fixed top-0 left-0 w-screen h-screen z-50 flex items-center justify-center p-4 bg-background/40 backdrop-blur-md animate-fade-in">
      <div role="dialog" aria-modal="true" aria-labelledby="add-guest-title" className="glass-panel rounded-3xl w-full max-w-md max-h-full overflow-y-auto animate-spring-up shadow-glass-lg">
        <div className="p-6 border-b border-white/10 flex justify-between items-center">
          <div className="min-w-0">
            <h3 id="add-guest-title" className="text-xl font-sans font-bold text-foreground uppercase tracking-wider">Add Guest Manually</h3>
            <p className="text-xs text-foreground/50 mt-1 truncate">To {subEvent.eventName}</p>
          </div>
          <button onClick={close} aria-label="Close" className="text-foreground/50 hover:text-foreground transition-colors">
            <XCircle className="w-5 h-5" />
          </button>
        </div>
        <div className="p-6">
          {error && (
            <div role="alert" className="mb-4 p-3 bg-destructive/10 text-destructive text-sm rounded-md border border-destructive/20">
              {error}
            </div>
          )}
          <form
            onSubmit={(e) => {
              // A refused keystroke or paste blocks saving until the field is corrected.
              if (phoneHint) {
                e.preventDefault();
                return;
              }
              return handleSubmit(onSubmit)(e);
            }}
            className="space-y-4"
          >
            <div>
              <Input label="Full Name" placeholder="John Doe" maxLength={GUEST_NAME_MAX} {...register('fullName')} error={errors.fullName?.message} />
              <CharCount value={wFullName} max={GUEST_NAME_MAX} />
            </div>

            <div className="flex gap-2">
              <div className="w-1/3">
                <label className="block text-sm font-sans text-foreground/80 mb-2">Country</label>
                <div
                  className="w-full rounded-md border border-border bg-surface/30 text-foreground/70 px-3 py-2.5 text-sm cursor-not-allowed select-none"
                  aria-label="Country"
                  title="This application sends only to Indian numbers"
                >
                  {COUNTRY_OPTIONS[0].label}
                </div>
                <input type="hidden" {...register('countryCode')} value={DEFAULT_COUNTRY_CODE} />
              </div>
              <div className="w-2/3">
                <Input
                  label="WhatsApp Number"
                  placeholder="9876543210"
                  inputMode="numeric"
                  {...phoneField}
                  onKeyDown={(e) => {
                    if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
                    const input = e.currentTarget;
                    const edit = insertMobileText(input.value, input.selectionStart ?? input.value.length, input.selectionEnd ?? input.value.length, e.key);
                    if (!edit.accepted) {
                      e.preventDefault();
                      setPhoneHint(edit.problem);
                    }
                  }}
                  onPaste={(e) => {
                    e.preventDefault();
                    const input = e.currentTarget;
                    const edit = insertMobileText(input.value, input.selectionStart ?? input.value.length, input.selectionEnd ?? input.value.length, e.clipboardData.getData('text'), true);
                    if (!edit.accepted) {
                      setPhoneHint(edit.problem);
                      return;
                    }
                    setValue('phoneNumber', edit.value, { shouldValidate: true, shouldDirty: true });
                    input.setSelectionRange(edit.caret, edit.caret);
                    setPhoneHint(null);
                  }}
                  onChange={(e) => {
                    const input = e.currentTarget;
                    const typed = limitMobileTyping(input.value, getValues('phoneNumber') ?? '', input.selectionStart ?? input.value.length);
                    if (typed.value !== input.value) {
                      input.value = typed.value;
                      input.setSelectionRange(typed.caret, typed.caret);
                    }
                    phoneField.onChange(e);
                    setPhoneHint(typed.problem);
                  }}
                  error={phoneHint ?? errors.phoneNumber?.message}
                />
                <CharCount value={indianSubscriberLength(wPhone)} max={INDIA_MOBILE_DIGITS} warnAtMax={false} />
              </div>
            </div>

            <div>
              <Input label="Email (Optional)" placeholder="john@gmail.com" maxLength={GUEST_EMAIL_MAX} {...register('email')} error={errors.email?.message} />
              <CharCount value={wEmail} max={GUEST_EMAIL_MAX} />
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <Button type="button" variant="ghost" onClick={close}>Cancel</Button>
              <Button type="submit" isLoading={isSubmitting}>Add Guest</Button>
            </div>
          </form>
        </div>
      </div>
    </div>,
    document.body
  );
};
