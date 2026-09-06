import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import api from '../services/api';
import { Lock, Eye, EyeOff, Loader2, Sun, Moon, ArrowLeft, CheckCircle2, ShieldAlert } from 'lucide-react';
import { useTheme } from '../store/themeStore';
import {
  PASSWORD_REQUIREMENTS,
  PASSWORD_MIN_LENGTH,
  validatePassword,
} from '@eventreach/shared';

const resetSchema = z
  .object({
    password: z.string().superRefine((value, ctx) => {
      // Reuse the exact policy the backend enforces so the two cannot drift.
      const problem = validatePassword(value);
      if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
    }),
    confirmPassword: z.string().min(1, 'Please confirm your password'),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

type ResetFormValues = z.infer<typeof resetSchema>;

const ResetPassword = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';
  const { theme, toggleTheme } = useTheme();

  const [showPassword, setShowPassword] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<ResetFormValues>({ resolver: zodResolver(resetSchema) });

  const passwordValue = watch('password') || '';

  const meets = (requirement: string): boolean => {
    if (requirement.includes('characters')) return passwordValue.length >= PASSWORD_MIN_LENGTH;
    if (requirement.includes('letter')) return /[A-Za-z]/.test(passwordValue);
    if (requirement.includes('number')) return /[0-9]/.test(passwordValue);
    return false;
  };

  const onSubmit = async (data: ResetFormValues) => {
    try {
      setApiError(null);
      await api.post('/auth/reset-password', { token, password: data.password });
      setDone(true);
      setTimeout(() => navigate('/login'), 2500);
    } catch (error: any) {
      setApiError(error.response?.data?.error || 'Something went wrong. Please try again.');
    }
  };

  const Shell = ({ children }: { children: React.ReactNode }) => (
    <div className="min-h-screen bg-background flex">
      <div className="absolute top-4 right-4 z-50">
        <button
          onClick={toggleTheme}
          className="p-2 rounded-md text-foreground/60 hover:text-foreground hover:bg-foreground/5 transition-colors bg-background/50 backdrop-blur-sm border border-border/50"
          title="Toggle Theme"
        >
          {theme === 'dark' ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
        </button>
      </div>

      <div className="hidden lg:flex lg:w-1/2 relative overflow-hidden items-center justify-center">
        <div className="relative z-10 perspective-1000">
          <img
            src={theme === 'dark' ? '/logo-dark.png' : '/logo.png'}
            alt="Events By Occasion Logo"
            className="w-64 h-auto object-contain dark:drop-shadow-2xl mix-blend-multiply dark:mix-blend-normal animate-spin-slow"
          />
        </div>
      </div>

      <div className="flex-1 flex flex-col justify-center py-12 px-4 sm:px-6 lg:px-20 xl:px-24">
        <div className="mx-auto w-full max-w-sm lg:max-w-md">
          <div className="flex justify-center mb-8 lg:hidden">
            <img
              src={theme === 'dark' ? '/logo-dark.png' : '/logo.png'}
              alt="Events By Occasion Logo"
              className="w-32 h-auto object-contain dark:drop-shadow-xl mix-blend-multiply dark:mix-blend-normal animate-spin-slow"
            />
          </div>
          {children}
        </div>
      </div>
    </div>
  );

  // A missing token means the link was mistyped or opened without the query string.
  if (!token) {
    return (
      <Shell>
        <div className="bg-card py-8 px-6 shadow-xl shadow-black/5 sm:rounded-2xl border border-border/50 text-center space-y-5 animate-spring-up">
          <div className="w-16 h-16 rounded-full bg-destructive/10 text-destructive flex items-center justify-center mx-auto">
            <ShieldAlert className="w-8 h-8" />
          </div>
          <h2 className="text-2xl font-bold text-foreground">Invalid reset link</h2>
          <p className="text-sm text-foreground/60 leading-relaxed">
            This password reset link is missing its token. Please request a new one.
          </p>
          <Link
            to="/forgot-password"
            className="inline-flex items-center justify-center text-sm font-bold text-accent hover:text-accent/80 transition-colors"
          >
            Request a new link
          </Link>
        </div>
      </Shell>
    );
  }

  if (done) {
    return (
      <Shell>
        <div className="bg-card py-8 px-6 shadow-xl shadow-black/5 sm:rounded-2xl border border-border/50 text-center space-y-5 animate-spring-up">
          <div className="w-16 h-16 rounded-full bg-accent/10 text-accent flex items-center justify-center mx-auto">
            <CheckCircle2 className="w-8 h-8" />
          </div>
          <h2 className="text-2xl font-bold text-foreground">Password reset</h2>
          <p className="text-sm text-foreground/60 leading-relaxed">
            Your password has been updated. Redirecting you to sign in…
          </p>
          <Link to="/login" className="inline-flex items-center text-sm font-bold text-accent hover:text-accent/80">
            <ArrowLeft className="w-4 h-4 mr-1.5" /> Go to Sign In
          </Link>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="text-center lg:text-left mb-8 animate-fade-in">
        <h2 className="text-3xl font-extrabold text-foreground tracking-tight">Set a new password</h2>
        <p className="mt-2 text-sm text-foreground/60">Choose a strong password you haven't used before</p>
      </div>

      <div className="bg-card py-8 px-4 shadow-xl shadow-black/5 sm:rounded-2xl sm:px-10 border border-border/50 animate-spring-up">
        {apiError && (
          <div className="bg-destructive/10 border border-destructive/20 text-destructive p-3 rounded-lg mb-6 text-sm text-center font-medium">
            {apiError}
          </div>
        )}

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">New Password</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Lock className="h-5 w-5 text-foreground/40" />
              </div>
              <input
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                {...register('password')}
                className={`block w-full pl-10 pr-10 py-2.5 border ${
                  errors.password ? 'border-destructive' : 'border-input'
                } rounded-lg bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent transition-all sm:text-sm`}
                placeholder="••••••••"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute inset-y-0 right-0 pr-3 flex items-center transition-colors"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? (
                  <EyeOff className="h-5 w-5 text-foreground/40 hover:text-foreground" />
                ) : (
                  <Eye className="h-5 w-5 text-foreground/40 hover:text-foreground" />
                )}
              </button>
            </div>
            {errors.password && (
              <p className="mt-1.5 text-sm text-destructive font-medium">{errors.password.message}</p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">Confirm Password</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Lock className="h-5 w-5 text-foreground/40" />
              </div>
              <input
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                {...register('confirmPassword')}
                className={`block w-full pl-10 pr-3 py-2.5 border ${
                  errors.confirmPassword ? 'border-destructive' : 'border-input'
                } rounded-lg bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent transition-all sm:text-sm`}
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
            {isSubmitting ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Reset Password'}
          </button>

          <div className="text-center mt-6 text-sm">
            <Link to="/login" className="inline-flex items-center font-bold text-accent hover:text-accent/80">
              <ArrowLeft className="w-4 h-4 mr-1.5" /> Back to Sign In
            </Link>
          </div>
        </form>
      </div>
    </Shell>
  );
};

export default ResetPassword;
