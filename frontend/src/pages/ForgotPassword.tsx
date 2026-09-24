import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link } from 'react-router-dom';
import { Mail, Loader2, CheckCircle2, ArrowLeft, Sun, Moon } from 'lucide-react';
import api from '../services/api';
import { useTheme } from '../store/themeStore';

const schema = z.object({
  email: z.string().email('Please enter a valid email address'),
});

type FormValues = z.infer<typeof schema>;

const GENERIC_MESSAGE =
  'If an account exists for that email, a password reset link has been sent. It expires in 15 minutes.';

/**
 * Self-service password recovery — step 1 of 2.
 *
 * Works for Super Admin, Admin and User accounts alike, and needs no admin
 * approval: identity is proven by owning the emailed link, not by anyone
 * simply knowing the address. The response is deliberately identical whether
 * or not the email matches an account, so this page can never be used to
 * find out who has one.
 */
const ForgotPassword = () => {
  const { theme, toggleTheme } = useTheme();
  const [apiError, setApiError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  const onSubmit = async (data: FormValues) => {
    try {
      setApiError(null);
      // The backend always answers the same way for a match or a miss — this
      // request is never used to decide what to show next.
      await api.post('/auth/forgot-password', data);
      setSent(true);
    } catch (error: any) {
      // A genuine failure (rate limited, server error) is the only thing
      // shown as an error here — never anything about whether the account
      // exists, which the backend never reveals in the first place.
      setApiError(error.response?.data?.error || 'Something went wrong. Please try again.');
    }
  };

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
            <h2 className="text-3xl font-extrabold text-foreground tracking-tight">Forgot Password?</h2>
            <p className="mt-2 text-sm text-foreground/60">
              Enter your account email and we'll send you a link to reset it.
            </p>
          </div>

          <div className="bg-card py-8 px-4 shadow-xl shadow-black/5 sm:rounded-2xl sm:px-10 border border-border/50 animate-spring-up">
            {sent ? (
              <div>
                <div className="bg-accent/10 border border-accent/20 text-accent p-4 rounded-lg text-sm font-medium flex gap-3">
                  <CheckCircle2 className="w-5 h-5 shrink-0 mt-0.5" />
                  <span>{GENERIC_MESSAGE}</span>
                </div>
                <p className="mt-6 text-xs text-foreground/50 leading-relaxed">
                  Didn't get an email? Check your spam folder, or{' '}
                  <button
                    type="button"
                    onClick={() => setSent(false)}
                    className="font-bold text-accent hover:text-accent/80"
                  >
                    try again
                  </button>
                  .
                </p>
              </div>
            ) : (
              <>
                {apiError && (
                  <div className="bg-destructive/10 border border-destructive/20 text-destructive p-3 rounded-lg mb-6 text-sm text-center font-medium">
                    {apiError}
                  </div>
                )}

                <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
                  <div>
                    <label className="block text-sm font-medium text-foreground mb-1.5">Email Address</label>
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                        <Mail className="h-5 w-5 text-foreground/40" />
                      </div>
                      <input
                        type="email"
                        autoComplete="email"
                        {...register('email')}
                        className={`block w-full pl-10 pr-3 py-2.5 border ${
                          errors.email ? 'border-destructive' : 'border-input'
                        } rounded-lg bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent transition-all sm:text-sm`}
                        placeholder="name@company.com"
                      />
                    </div>
                    {errors.email && (
                      <p className="mt-1.5 text-sm text-destructive font-medium">{errors.email.message}</p>
                    )}
                  </div>

                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="w-full flex justify-center py-2.5 px-4 border border-transparent rounded-lg shadow-sm text-sm font-bold text-white bg-accent hover:bg-accent/90 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-accent disabled:opacity-50 disabled:cursor-not-allowed transition-all transform active:scale-[0.98]"
                  >
                    {isSubmitting ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Send Reset Link'}
                  </button>
                </form>
              </>
            )}

            <Link
              to="/login"
              className="mt-8 w-full flex items-center justify-center gap-2 py-2 text-sm font-bold text-foreground/70 hover:text-foreground transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              Back to Login
            </Link>

            <div className="mt-4 text-center text-xs">
              <Link to="/privacy-policy" className="text-foreground/40 hover:text-foreground/70 transition-colors">
                Privacy Policy
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ForgotPassword;
