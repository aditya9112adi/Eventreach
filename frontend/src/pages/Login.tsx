import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useNavigate, Link, useLocation } from 'react-router-dom';
import { useAuth } from '../store/authStore';
import api from '../services/api';
import { AlertCircle, Lock, Mail, Moon, Sun } from 'lucide-react';
import { useTheme } from '../store/themeStore';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { PasswordInput } from '../components/ui/PasswordInput';

const loginSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
});

type LoginFormValues = z.infer<typeof loginSchema>;

const Login = () => {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { theme, toggleTheme } = useTheme();
  const [apiError, setApiError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
  });

  const onSubmit = async (data: LoginFormValues) => {
    try {
      setApiError(null);
      const response = await api.post('/auth/login', data);
      login(response.data.token, response.data.user);
      navigate('/dashboard');
    } catch (error: any) {
      setApiError(error.response?.data?.error || 'Something went wrong. Please try again.');
    }
  };

  const banner = location.state?.message || apiError;

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
            Every guest reached, on time.
          </h2>
          <p className="mt-4 text-md text-muted">
            Plan events, manage guest lists and run WhatsApp campaigns from one place — with full
            delivery reporting on every message you send.
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
            <h1 className="text-h1 font-semibold tracking-tight text-foreground">Welcome back</h1>
            <p className="mt-1.5 text-sm text-muted">
              Sign in to manage your events and campaigns.
            </p>
          </div>

          {banner && (
            <div
              role="alert"
              className="mb-5 flex items-start gap-2.5 rounded-lg border border-destructive/25 bg-destructive/10 px-3.5 py-3 text-sm text-destructive"
            >
              <AlertCircle className="mt-px h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="font-medium">{banner}</span>
            </div>
          )}

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
            <Input
              label="Email address"
              type="email"
              autoComplete="email"
              placeholder="name@company.com"
              icon={<Mail className="h-4 w-4" />}
              error={errors.email?.message}
              {...register('email')}
            />

            <PasswordInput
              label="Password"
              autoComplete="current-password"
              placeholder="••••••••"
              icon={<Lock className="h-4 w-4" />}
              error={errors.password?.message}
              {...register('password')}
            />

            <Button type="submit" size="lg" block isLoading={isSubmitting} className="!mt-6">
              {isSubmitting ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-muted">
            Don't have an account?{' '}
            <Link
              to="/register"
              className="font-medium text-primary transition-colors duration-micro hover:text-primary-hover"
            >
              Create one
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
};

export default Login;
