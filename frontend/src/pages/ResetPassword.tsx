import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useSearchParams } from 'react-router-dom';
import { Lock, Eye, EyeOff, Loader2, CheckCircle2, XCircle, KeyRound, Sun, Moon } from 'lucide-react';
import api from '../services/api';
import { useTheme } from '../store/themeStore';
import { PASSWORD_REQUIREMENTS } from '@eventreach/shared';
import { meetsRequirement } from '../utils/passwordRequirements';
import { newPasswordSchema, type NewPasswordFormValues } from '../utils/newPasswordValidation';

type Stage = 'checking' | 'invalid' | 'ready' | 'done';

/**
 * Self-service password recovery — step 2 of 2.
 *
 * Reached only via the single-use link emailed by ForgotPassword. The token
 * is verified before the new-password form is ever shown; submitting it is
 * what actually proves the caller controls the account and completes the
 * reset — the email address alone was never enough.
 */
const ResetPassword = () => {
  const { theme, toggleTheme } = useTheme();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';

  const [stage, setStage] = useState<Stage>('checking');
  const [showPassword, setShowPassword] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<NewPasswordFormValues>({ resolver: zodResolver(newPasswordSchema) });

  const newPasswordValue = watch('newPassword') || '';
  const meets = (requirement: string): boolean => meetsRequirement(requirement, newPasswordValue);

  useEffect(() => {
    if (!token) {
      setStage('invalid');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const response = await api.post('/auth/verify-reset-token', { token });
        if (!cancelled) setStage(response.data?.valid ? 'ready' : 'invalid');
      } catch {
        if (!cancelled) setStage('invalid');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const onSubmit = async (data: NewPasswordFormValues) => {
    try {
      setApiError(null);
      await api.post('/auth/reset-password', {
        token,
        newPassword: data.newPassword,
        // The backend re-checks the confirmation rather than trusting the form.
        confirmPassword: data.confirmPassword,
      });
      setStage('done');
    } catch (error: any) {
      // A token can lapse or get used (e.g. in another tab) between the
      // verify check and submission — surface that rather than a raw 400.
      const message = error.response?.data?.error || 'Something went wrong. Please try again.';
      if (error.response?.status === 400 && /invalid or has expired/i.test(message)) {
        setStage('invalid');
        return;
      }
      setApiError(message);
    }
  };

  const inputClass = (hasError: boolean) =>
    `block w-full pl-10 pr-10 py-2.5 border ${
      hasError ? 'border-destructive' : 'border-input'
    } rounded-lg bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent transition-all sm:text-sm`;

  return (
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
            <div className="perspective-1000">
              <img
                src={theme === 'dark' ? '/logo-dark.png' : '/logo.png'}
                alt="Events By Occasion Logo"
                className="w-32 h-auto object-contain dark:drop-shadow-xl mix-blend-multiply dark:mix-blend-normal animate-spin-slow"
              />
            </div>
          </div>

          <div className="text-center lg:text-left mb-8 animate-fade-in">
            <h2 className="text-3xl font-extrabold text-foreground tracking-tight">Reset Password</h2>
            <p className="mt-2 text-sm text-foreground/60">Choose a new password for your account.</p>
          </div>

          <div className="bg-card py-8 px-4 shadow-xl shadow-black/5 sm:rounded-2xl sm:px-10 border border-border/50 animate-spring-up">
            {stage === 'checking' && (
              <div className="flex flex-col items-center py-8 text-foreground/60">
                <Loader2 className="w-6 h-6 animate-spin mb-3" />
                <p className="text-sm">Checking your reset link…</p>
              </div>
            )}

            {stage === 'invalid' && (
              <div>
                <div className="bg-destructive/10 border border-destructive/20 text-destructive p-4 rounded-lg text-sm font-medium flex gap-3">
                  <XCircle className="w-5 h-5 shrink-0 mt-0.5" />
                  <span>This password reset link is invalid or has expired.</span>
                </div>
                <Link
                  to="/forgot-password"
                  className="mt-6 w-full flex items-center justify-center gap-2 py-2.5 px-4 border border-transparent rounded-lg shadow-sm text-sm font-bold text-white bg-accent hover:bg-accent/90 transition-all"
                >
                  Request a new link
                </Link>
              </div>
            )}

            {stage === 'done' && (
              <div>
                <div className="bg-accent/10 border border-accent/20 text-accent p-4 rounded-lg text-sm font-medium flex gap-3">
                  <CheckCircle2 className="w-5 h-5 shrink-0 mt-0.5" />
                  <span>Your password has been reset. Any other signed-in sessions have been signed out.</span>
                </div>
                <Link
                  to="/login"
                  className="mt-6 w-full flex items-center justify-center gap-2 py-2.5 px-4 border border-transparent rounded-lg shadow-sm text-sm font-bold text-white bg-accent hover:bg-accent/90 transition-all"
                >
                  Sign In
                </Link>
              </div>
            )}

            {stage === 'ready' && (
              <>
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
                        {...register('newPassword')}
                        className={inputClass(Boolean(errors.newPassword))}
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
                    {errors.newPassword && (
                      <p className="mt-1.5 text-sm text-destructive font-medium">{errors.newPassword.message}</p>
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
                    {isSubmitting ? <Loader2 className="w-5 h-5 animate-spin" /> : (
                      <span className="flex items-center gap-2">
                        <KeyRound className="w-4 h-4" />
                        Update Password
                      </span>
                    )}
                  </button>
                </form>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ResetPassword;
