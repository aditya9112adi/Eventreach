import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useNavigate, Link } from 'react-router-dom';
import api from '../services/api';
import { AlertCircle, Calendar, CheckCircle2, Lock, Mail, Moon, Sun, User } from 'lucide-react';
import { useTheme } from '../store/themeStore';
import { validatePassword, PASSWORD_REQUIREMENTS } from '@eventreach/shared';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { PasswordInput } from '../components/ui/PasswordInput';
import { Select } from '../components/ui/Select';
import { meetsRequirement } from '../utils/passwordRequirements';

const registerSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  email: z.string().email('Please enter a valid email address'),
  password: z.string().superRefine((value, ctx) => {
    // Same policy the backend enforces, so the form cannot submit something the
    // API will reject.
    const problem = validatePassword(value);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  }),
  role: z.enum(['Admin', 'User']),
  accessStartDate: z.string().optional(),
  accessEndDate: z.string().optional(),
}).superRefine((data, ctx) => {
  if (data.role === 'Admin') {
    const now = new Date();
    if (!data.accessStartDate) {
      ctx.addIssue({ code: 'custom', path: ['accessStartDate'], message: 'Access Start Date is required for Admin.' });
    } else if (new Date(data.accessStartDate) < now) {
      ctx.addIssue({ code: 'custom', path: ['accessStartDate'], message: 'Access Start Date cannot be in the past.' });
    }
    if (!data.accessEndDate) {
      ctx.addIssue({ code: 'custom', path: ['accessEndDate'], message: 'Access End Date is required for Admin.' });
    } else if (new Date(data.accessEndDate) < now) {
      ctx.addIssue({ code: 'custom', path: ['accessEndDate'], message: 'Access End Date cannot be in the past.' });
    }
    if (data.accessStartDate && data.accessEndDate && new Date(data.accessEndDate) <= new Date(data.accessStartDate)) {
      ctx.addIssue({ code: 'custom', path: ['accessEndDate'], message: 'Access End Date must be after Access Start Date.' });
    }
  }
});

type RegisterFormValues = z.infer<typeof registerSchema>;

const Register = () => {
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const [apiError, setApiError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<RegisterFormValues>({
    resolver: zodResolver(registerSchema),
    defaultValues: { role: 'User' },
  });

  const selectedRole = watch('role');
  const passwordValue = watch('password') || '';

  // Compute current local datetime in the format required by datetime-local min attribute
  const getNowMin = () => {
    const now = new Date();
    const tzOffset = now.getTimezoneOffset() * 60000;
    return new Date(now.getTime() - tzOffset).toISOString().slice(0, 16);
  };

  const onSubmit = async (data: RegisterFormValues) => {
    try {
      setApiError(null);
      setSuccessMsg(null);

      // Fix Timezone shift: datetime-local inputs return "YYYY-MM-DDTHH:mm" which is local time,
      // but servers in UTC will parse it as UTC time.
      // We convert it to a fully qualified UTC ISO string using the browser's local timezone.
      const payload = { ...data };
      if (payload.accessStartDate) {
        payload.accessStartDate = new Date(payload.accessStartDate).toISOString();
      }
      if (payload.accessEndDate) {
        payload.accessEndDate = new Date(payload.accessEndDate).toISOString();
      }

      const response = await api.post('/auth/register', payload);
      setSuccessMsg(response.data.message);
      setTimeout(() => navigate('/login'), 3000);
    } catch (error: any) {
      setApiError(error.response?.data?.error || 'Something went wrong. Please try again.');
    }
  };

  const dateFieldClass = (invalid?: boolean) =>
    [
      'h-9 w-full rounded-md border bg-surface px-3 text-sm text-foreground',
      'transition-[border-color,box-shadow] duration-control ease-out-expo',
      'focus:outline-none focus:ring-2',
      invalid
        ? 'border-destructive focus:border-destructive focus:ring-destructive/25'
        : 'border-input hover:border-muted/60 focus:border-primary focus:ring-primary/25',
    ].join(' ');

  return (
    <div className="flex min-h-screen bg-background">
      <button
        type="button"
        onClick={toggleTheme}
        aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        className="absolute right-4 top-4 z-50 rounded-md border border-border bg-surface p-2 text-muted shadow-xs transition-colors duration-micro hover:text-foreground"
      >
        {theme === 'dark' ? (
          <Sun className="h-4.5 w-4.5" aria-hidden="true" />
        ) : (
          <Moon className="h-4.5 w-4.5" aria-hidden="true" />
        )}
      </button>

      {/* Brand panel — desktop only. */}
      <div className="relative hidden w-1/2 flex-col justify-between overflow-hidden border-r border-border bg-surface p-12 lg:flex">
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage:
              'radial-gradient(circle at 1px 1px, rgb(var(--color-foreground)) 1px, transparent 0)',
            backgroundSize: '24px 24px',
          }}
          aria-hidden="true"
        />

        <img
          src={theme === 'dark' ? '/logo-dark.png' : '/logo.png'}
          alt="Events By Occasion"
          className="relative h-10 w-auto object-contain object-left mix-blend-multiply dark:mix-blend-normal"
        />

        <div className="relative max-w-md">
          <h2 className="text-display font-semibold tracking-tight text-foreground">
            Request access to the workspace.
          </h2>
          <p className="mt-4 text-md text-muted">
            New accounts are reviewed by a Super Admin before they go live. You'll be able to sign in
            as soon as your request is approved.
          </p>
        </div>

        <p className="relative text-xs text-muted">
          © {new Date().getFullYear()} Events By Occasion
        </p>
      </div>

      {/* Form panel */}
      <div className="flex flex-1 flex-col justify-center px-4 py-12 sm:px-6 lg:px-16 xl:px-24">
        <div className="mx-auto w-full max-w-sm">
          <img
            src={theme === 'dark' ? '/logo-dark.png' : '/logo.png'}
            alt="Events By Occasion"
            className="mx-auto mb-8 h-10 w-auto object-contain mix-blend-multiply dark:mix-blend-normal lg:hidden"
          />

          <div className="mb-7">
            <h1 className="text-h1 font-semibold tracking-tight text-foreground">Create account</h1>
            <p className="mt-1.5 text-sm text-muted">
              Register to join Events By Occasion.
            </p>
          </div>

          {apiError && (
            <div
              role="alert"
              className="mb-5 flex items-start gap-2.5 rounded-lg border border-destructive/25 bg-destructive/10 px-3.5 py-3 text-sm font-medium text-destructive"
            >
              <AlertCircle className="mt-px h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{apiError}</span>
            </div>
          )}

          {successMsg && (
            <div
              role="status"
              className="mb-5 flex items-start gap-2.5 rounded-lg border border-success/25 bg-success/10 px-3.5 py-3 text-sm font-medium text-success"
            >
              <CheckCircle2 className="mt-px h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{successMsg}</span>
            </div>
          )}

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
            <Input
              label="Full name"
              type="text"
              autoComplete="name"
              placeholder="John Doe"
              icon={<User className="h-4 w-4" />}
              error={errors.name?.message}
              {...register('name')}
            />

            <Input
              label="Email address"
              type="email"
              autoComplete="email"
              placeholder="name@company.com"
              icon={<Mail className="h-4 w-4" />}
              error={errors.email?.message}
              {...register('email')}
            />

            <div>
              <PasswordInput
                label="Password"
                autoComplete="new-password"
                placeholder="••••••••"
                icon={<Lock className="h-4 w-4" />}
                error={errors.password?.message}
                {...register('password')}
              />
              {/* Live checklist: the same rules the API enforces, so the user can
                  see what is still missing instead of guessing after a rejection. */}
              <ul className="mt-2 space-y-1">
                {PASSWORD_REQUIREMENTS.map((requirement) => {
                  const met = meetsRequirement(requirement, passwordValue);
                  return (
                    <li
                      key={requirement}
                      className={`flex items-center gap-1.5 text-xs ${
                        met ? 'text-success' : 'text-muted'
                      }`}
                    >
                      <CheckCircle2
                        className={`h-3.5 w-3.5 shrink-0 ${met ? '' : 'opacity-40'}`}
                        aria-hidden="true"
                      />
                      {requirement}
                    </li>
                  );
                })}
              </ul>
            </div>

            <Select label="Role" error={undefined} {...register('role')}>
              <option value="User">User</option>
              <option value="Admin">Admin</option>
            </Select>

            {/* Access Date Fields — shown only when Admin is selected */}
            {selectedRole === 'Admin' && (
              <div className="animate-fade-in space-y-4 rounded-xl border border-primary/20 bg-primary/5 p-4">
                <div>
                  <p className="flex items-center gap-2 text-sm font-semibold text-primary">
                    <Calendar className="h-4 w-4" aria-hidden="true" /> Access period request
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    Specify the period during which you require access. The Super Admin will approve
                    this request as-is.
                  </p>
                </div>

                <div>
                  <label
                    htmlFor="accessStartDate"
                    className="mb-1.5 block text-sm font-medium text-foreground"
                  >
                    Access start date &amp; time <span className="text-destructive">*</span>
                  </label>
                  <input
                    id="accessStartDate"
                    type="datetime-local"
                    min={getNowMin()}
                    aria-invalid={errors.accessStartDate ? true : undefined}
                    className={dateFieldClass(Boolean(errors.accessStartDate))}
                    {...register('accessStartDate')}
                  />
                  {errors.accessStartDate && (
                    <p role="alert" className="mt-1.5 text-xs font-medium text-destructive">
                      {errors.accessStartDate.message}
                    </p>
                  )}
                </div>

                <div>
                  <label
                    htmlFor="accessEndDate"
                    className="mb-1.5 block text-sm font-medium text-foreground"
                  >
                    Access end date &amp; time <span className="text-destructive">*</span>
                  </label>
                  <input
                    id="accessEndDate"
                    type="datetime-local"
                    min={getNowMin()}
                    aria-invalid={errors.accessEndDate ? true : undefined}
                    className={dateFieldClass(Boolean(errors.accessEndDate))}
                    {...register('accessEndDate')}
                  />
                  {errors.accessEndDate && (
                    <p role="alert" className="mt-1.5 text-xs font-medium text-destructive">
                      {errors.accessEndDate.message}
                    </p>
                  )}
                </div>
              </div>
            )}

            <Button type="submit" size="lg" block isLoading={isSubmitting} className="!mt-6">
              {isSubmitting ? 'Creating account…' : 'Create account'}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-muted">
            Already have an account?{' '}
            <Link
              to="/login"
              className="font-medium text-primary transition-colors duration-micro hover:text-primary-hover"
            >
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
};

export default Register;
