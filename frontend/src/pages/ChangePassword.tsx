import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { AlertCircle, CheckCircle2, Lock } from 'lucide-react';
import api from '../services/api';
import { useAuth } from '../store/authStore';
import { useToast } from '../components/ui/Toast';
import { Button } from '../components/ui/Button';
import { PasswordInput } from '../components/ui/PasswordInput';
import { Card } from '../components/ui/Card';
import { PageHeader } from '../components/ui/PageHeader';
import { meetsRequirement } from '../utils/passwordRequirements';
import { PASSWORD_REQUIREMENTS, validatePassword } from '@eventreach/shared';

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

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader
        title="Change password"
        description={`Update the password for ${user?.email ?? 'your account'}.`}
      />

      <Card flush>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-5 p-5 sm:p-6" noValidate>
          {apiError && (
            <div
              role="alert"
              className="flex items-start gap-2.5 rounded-lg border border-destructive/25 bg-destructive/10 px-3.5 py-3 text-sm font-medium text-destructive"
            >
              <AlertCircle className="mt-px h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{apiError}</span>
            </div>
          )}

          {done && (
            <div
              role="status"
              className="flex items-start gap-2.5 rounded-lg border border-success/25 bg-success/10 px-3.5 py-3 text-sm font-medium text-success"
            >
              <CheckCircle2 className="mt-px h-4 w-4 shrink-0" aria-hidden="true" />
              <span>
                Your password has been changed. Any other signed-in sessions have been signed out.
              </span>
            </div>
          )}

          <PasswordInput
            label="Current password"
            autoComplete="current-password"
            placeholder="••••••••"
            icon={<Lock className="h-4 w-4" />}
            error={errors.currentPassword?.message}
            {...register('currentPassword')}
          />

          <PasswordInput
            label="New password"
            autoComplete="new-password"
            placeholder="••••••••"
            icon={<Lock className="h-4 w-4" />}
            error={errors.newPassword?.message}
            {...register('newPassword')}
          />

          <PasswordInput
            label="Confirm new password"
            autoComplete="new-password"
            placeholder="••••••••"
            icon={<Lock className="h-4 w-4" />}
            error={errors.confirmPassword?.message}
            {...register('confirmPassword')}
          />

          <div className="rounded-lg border border-border bg-surfaceHover/50 p-4">
            <p className="label-caption mb-2">Password requirements</p>
            <ul className="space-y-1.5">
              {PASSWORD_REQUIREMENTS.map((requirement) => {
                const ok = meetsRequirement(requirement, newPasswordValue);
                return (
                  <li key={requirement} className="flex items-center gap-2 text-xs">
                    <CheckCircle2
                      className={`h-3.5 w-3.5 shrink-0 ${ok ? 'text-success' : 'text-muted/40'}`}
                      aria-hidden="true"
                    />
                    <span className={ok ? 'text-foreground' : 'text-muted'}>{requirement}</span>
                  </li>
                );
              })}
            </ul>
          </div>

          <Button type="submit" size="lg" block isLoading={isSubmitting}>
            {isSubmitting ? 'Changing password…' : 'Change password'}
          </Button>
        </form>
      </Card>
    </div>
  );
};

export default ChangePassword;
