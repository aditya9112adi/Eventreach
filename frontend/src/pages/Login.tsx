import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../store/authStore';
import api from '../services/api';
import { MessageSquare, Lock, Mail, EyeOff, Eye, Loader2, Sun, Moon } from 'lucide-react';
import { useTheme } from '../store/themeStore';

const loginSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
});

type LoginFormValues = z.infer<typeof loginSchema>;

const Login = () => {
  const { login } = useAuth();
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const [showPassword, setShowPassword] = useState(false);
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
      setApiError(
        error.response?.data?.error || 'Something went wrong. Please try again.'
      );
    }
  };

  return (
    <div className="min-h-screen bg-background flex">
      {/* Theme Toggle */}
      <div className="absolute top-4 right-4 z-50">
        <button
          onClick={toggleTheme}
          className="p-2 rounded-md text-foreground/60 hover:text-foreground hover:bg-foreground/5 transition-colors bg-background/50 backdrop-blur-sm border border-border/50"
          title="Toggle Theme"
        >
          {theme === 'dark' ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
        </button>
      </div>

      {/* Left Column - 3D Rotating Logo (Desktop Only) */}
      <div className="hidden lg:flex lg:w-1/2 bg-surfaceHover relative overflow-hidden items-center justify-center border-r border-border/10">
        <div className="absolute inset-0 bg-gradient-to-br from-accent/10 to-transparent pointer-events-none" />
        
        {/* Decorative background circle */}
        <div className="absolute w-[600px] h-[600px] bg-accent/5 rounded-full blur-3xl" />
        
        <div className="relative z-10 perspective-1000">
          <img 
            src={theme === 'dark' ? '/logo-dark.png' : '/logo.png'}
            alt="Events By Occasion Logo" 
            className="w-96 h-auto object-contain drop-shadow-2xl animate-spin-3d" 
          />
        </div>
      </div>

      {/* Right Column - Form */}
      <div className="flex-1 flex flex-col justify-center py-12 px-4 sm:px-6 lg:px-20 xl:px-24">
        <div className="mx-auto w-full max-w-sm lg:max-w-md">
          {/* Mobile Logo (Visible only on small screens) */}
          <div className="flex justify-center mb-8 lg:hidden">
            <div className="perspective-1000">
              <img 
                src={theme === 'dark' ? '/logo-dark.png' : '/logo.png'}
                alt="Events By Occasion Logo" 
                className="w-40 h-auto object-contain drop-shadow-xl animate-spin-3d" 
              />
            </div>
          </div>
          
          <div className="text-center lg:text-left mb-8 animate-fade-in">
            <h2 className="text-3xl font-extrabold text-foreground tracking-tight">
              Welcome Back
            </h2>
            <p className="mt-2 text-sm text-foreground/60">
              Sign in to manage your events and campaigns
            </p>
          </div>

          <div className="bg-card py-8 px-4 shadow-xl shadow-black/5 sm:rounded-2xl sm:px-10 border border-border/50 animate-spring-up">
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

              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">
                  Password
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <Lock className="h-5 w-5 text-foreground/40" />
                  </div>
                  <input
                    type={showPassword ? 'text' : 'password'}
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
                  >
                    {showPassword ? (
                      <EyeOff className="h-5 w-5 text-foreground/40 hover:text-foreground" />
                    ) : (
                      <Eye className="h-5 w-5 text-foreground/40 hover:text-foreground" />
                    )}
                  </button>
                </div>
                {errors.password && (
                  <p className="mt-1.5 text-sm text-destructive font-medium">
                    {errors.password.message}
                  </p>
                )}
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center">
                  <input
                    id="remember-me"
                    name="remember-me"
                    type="checkbox"
                    className="h-4 w-4 text-accent focus:ring-accent border-input rounded bg-background"
                  />
                  <label
                    htmlFor="remember-me"
                    className="ml-2 block text-sm font-medium text-foreground/80 cursor-pointer"
                  >
                    Remember me
                  </label>
                </div>
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full flex justify-center py-2.5 px-4 border border-transparent rounded-lg shadow-sm text-sm font-bold text-white bg-accent hover:bg-accent/90 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-accent disabled:opacity-50 disabled:cursor-not-allowed transition-all transform active:scale-[0.98]"
              >
                {isSubmitting ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  'Sign In'
                )}
              </button>

              <div className="text-center mt-6 text-sm">
                <span className="text-foreground/60">Don't have an account? </span>
                <Link to="/register" className="font-bold text-accent hover:text-accent/80 transition-colors">
                  Create an account
                </Link>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Login;
