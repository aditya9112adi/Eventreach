import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link } from 'react-router-dom';
import api from '../services/api';
import { Mail, Loader2, Sun, Moon, ArrowLeft, MailCheck } from 'lucide-react';
import { useTheme } from '../store/themeStore';

const forgotSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
});

type ForgotFormValues = z.infer<typeof forgotSchema>;

const ForgotPassword = () => {
  const { theme, toggleTheme } = useTheme();
  const [apiError, setApiError] = useState<string | null>(null);
  const [sentMessage, setSentMessage] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ForgotFormValues>({ resolver: zodResolver(forgotSchema) });

  const onSubmit = async (data: ForgotFormValues) => {
    try {
      setApiError(null);
      const response = await api.post('/auth/forgot-password', data);
      // The server intentionally returns the same message whether or not the
      // address exists, so we simply show what it tells us.
      setSentMessage(
        response.data?.message ||
          'If an account exists with this email address, a password reset link has been sent.'
      );
    } catch (error: any) {
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

      {/* Left Column - Logo (Desktop Only) */}
      <div className="hidden lg:flex lg:w-1/2 relative overflow-hidden items-center justify-center">
        <div className="relative z-10 perspective-1000">
          <img
            src={theme === 'dark' ? '/logo-dark.png' : '/logo.png'}
            alt="Events By Occasion Logo"
            className="w-64 h-auto object-contain dark:drop-shadow-2xl mix-blend-multiply dark:mix-blend-normal animate-spin-slow"
          />
        </div>
      </div>

      {/* Right Column - Form */}
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
            <h2 className="text-3xl font-extrabold text-foreground tracking-tight">
              Forgot Password
            </h2>
            <p className="mt-2 text-sm text-foreground/60">
              Enter your registered email and we'll send you a reset link
            </p>
          </div>

          <div className="bg-card py-8 px-4 shadow-xl shadow-black/5 sm:rounded-2xl sm:px-10 border border-border/50 animate-spring-up">
            {sentMessage ? (
              <div className="text-center space-y-6">
                <div className="w-16 h-16 rounded-full bg-accent/10 text-accent flex items-center justify-center mx-auto">
                  <MailCheck className="w-8 h-8" />
                </div>
                <p className="text-sm text-foreground/80 leading-relaxed">{sentMessage}</p>
                <p className="text-xs text-foreground/50">
                  The link expires shortly and can only be used once. Remember to check your spam folder.
                </p>
                <Link
                  to="/login"
                  className="inline-flex items-center justify-center text-sm font-bold text-accent hover:text-accent/80 transition-colors"
                >
                  <ArrowLeft className="w-4 h-4 mr-1.5" /> Back to Sign In
                </Link>
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
                    <label className="block text-sm font-medium text-foreground mb-1.5">
                      Email Address
                    </label>
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

                  <div className="text-center mt-6 text-sm">
                    <Link
                      to="/login"
                      className="inline-flex items-center font-bold text-accent hover:text-accent/80 transition-colors"
                    >
                      <ArrowLeft className="w-4 h-4 mr-1.5" /> Back to Sign In
                    </Link>
                  </div>
                </form>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ForgotPassword;
