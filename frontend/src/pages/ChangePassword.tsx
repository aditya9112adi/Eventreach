import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Lock, Eye, EyeOff, Loader2, CheckCircle2, KeyRound } from 'lucide-react';
import api from '../services/api';
import { useAuth } from '../store/authStore';
import { useToast } from '../components/ui/Toast';
import {
  PASSWORD_REQUIREMENTS,
  PASSWORD_MIN_LENGTH,
  validatePassword,
} from '@eventreach/shared';

const schema = z
  .object({
    currentPassword: z.string().min(1, 'Please enter your current password'),
    newPassword: z.string().superRefine((value, ctx) => {
      // Reuse the exact policy the backend enforces so the two cannot drift.
      const problem = validatePassword(value);
      if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
    }),
    confirmPassword: z.string().min(1, 'Please confirm your new password'),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })
  .refine((data) => data.newPassword !== data.currentPassword, {
    message: 'The new password must be different from your current one',
    path: ['newPassword'],
  });

type FormValues = z.infer<typeof schema>;

/**
 * Self-service password change for any signed-in role.
 *
 * Knowledge of the current password is what proves identity — there is no email
 * or admin approval step in this app.
 */
const ChangePassword = () => {
  const { user, login } = useAuth();
  const { showToast } = useToast();
  const [showPassword, setShowPassword] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const {
    register,
    handleSubmit,
    watch,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  const newPasswordValue = watch('newPassword') || '';

  const meets = (requirement: string): boolean => {
    if (requirement.includes('characters')) return newPasswordValue.length >= PASSWORD_MIN_LENGTH;
    if (requirement.includes('letter')) return /[A-Za-z]/.test(newPasswordValue);
    if (requirement.includes('number')) return /[0-9]/.test(newPasswordValue);
    return false;
  };

  const onSubmit = async (data: FormValues) => {
    try {
      setApiError(null);
      const response = await api.post('/auth/change-password', {
        currentPassword: data.currentPassword,
        newPassword: data.newPassword,
      });

      // Changing the password revokes every token issued earlier, including the
      // one this request used. Adopt the fresh token so this session stays
      // signed in while any other session is signed out.
      if (response.data?.token && user) {
        login(response.data.token, user);
      }

      reset();
      setDone(true);
      showToast('success', 'Your password has been changed');
    } catch (error: any) {
      setApiError(error.response?.data?.error || 'Something went wrong. Please try again.');
    }
  };

  const inputClass = (hasError: boolean) =>
    `block w-full pl-10 pr-10 py-2.5 border ${
      hasError ? 'border-destructive' : 'border-input'
    } rounded-lg bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent transition-all sm:text-sm`;

  return (
    <div className="max-w-xl mx-auto space-y-6">
      <div className="flex items-center justify-between animate-fade-in">
        <div>
          <h1 className="text-2xl font-bold">Change Password</h1>
          <p className="text-foreground/60 text-sm mt-1">
            Update the password for {user?.email}
          </p>
        </div>
        <div className="p-3 bg-accent/20 rounded-full">
          <KeyRound className="w-6 h-6 text-accent" />
        </div>
      </div>

      <div className="bg-surface rounded-xl border border-border p-6 md:p-8 animate-fade-up">
        {apiError && (
          <div className="bg-destructive/10 border border-destructive/20 text-destructive p-3 rounded-lg mb-6 text-sm font-medium">
            {apiError}
          </div>
        )}

        {done && (
          <div className="bg-accent/10 border border-accent/20 text-accent p-3 rounded-lg mb-6 text-sm font-medium flex items-center">
            <CheckCircle2 className="w-4 h-4 mr-2 shrink-0" />
            Your password has been changed. Any other signed-in sessions have been signed out.
          </div>
        )}

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">Current Password</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Lock className="h-5 w-5 text-foreground/40" />
              </div>
              <input
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                {...register('currentPassword')}
                className={inputClass(Boolean(errors.currentPassword))}
                placeholder="••••••••"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute inset-y-0 right-0 pr-3 flex items-center"
                aria-label={showPassword ? 'Hide passwords' : 'Show passwords'}
              >
                {showPassword ? (
                  <EyeOff className="h-5 w-5 text-foreground/40 hover:text-foreground" />
                ) : (
                  <Eye className="h-5 w-5 text-foreground/40 hover:text-foreground" />
                )}
              </button>
            </div>
            {errors.currentPassword && (
              <p className="mt-1.5 text-sm text-destructive font-medium">{errors.currentPassword.message}</p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">New Password</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Lock className="h-5 w-5 text-foreground/40" />
              </div>
              <input
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                {...register('newPassword')}
                className={inputClass(Boolean(errors.newPassword))}
                placeholder="••••••••"
              />
            </div>
            {errors.newPassword && (
              <p className="mt-1.5 text-sm text-destructive font-medium">{errors.newPassword.message}</p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">Confirm New Password</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Lock className="h-5 w-5 text-foreground/40" />
              </div>
              <input
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                {...register('confirmPassword')}
                className={inputClass(Boolean(errors.confirmPassword))}
                placeholder="••••••••"
              />
            </div>
            {errors.confirmPassword && (
              <p className="mt-1.5 text-sm text-destructive font-medium">{errors.confirmPassword.message}</p>
            )}
          </div>

          <div className="rounded-lg border border-border bg-background/50 p-4">
            <p className="text-xs font-bold uppercase tracking-wider text-foreground/60 mb-2">
              Password requirements
            </p>
            <ul className="space-y-1.5">
              {PASSWORD_REQUIREMENTS.map((requirement) => {
                const ok = meets(requirement);
                return (
                  <li key={requirement} className="flex items-center text-xs">
                    <CheckCircle2
                      className={`w-3.5 h-3.5 mr-2 shrink-0 ${ok ? 'text-accent' : 'text-foreground/25'}`}
                    />
                    <span className={ok ? 'text-foreground' : 'text-foreground/50'}>{requirement}</span>
                  </li>
                );
              })}
            </ul>
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full flex justify-center py-2.5 px-4 border border-transparent rounded-lg shadow-sm text-sm font-bold text-white bg-accent hover:bg-accent/90 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-accent disabled:opacity-50 disabled:cursor-not-allowed transition-all transform active:scale-[0.98]"
          >
            {isSubmitting ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Change Password'}
          </button>
        </form>
      </div>
    </div>
  );
};

export default ChangePassword;
