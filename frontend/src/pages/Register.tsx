import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useNavigate, Link } from 'react-router-dom';
import api from '../services/api';
import { User, Mail, Lock, EyeOff, Eye, Loader2, Sun, Moon, Briefcase } from 'lucide-react';
import { useTheme } from '../store/themeStore';

const registerSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  email: z.string().email('Please enter a valid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  role: z.enum(['Admin', 'User']),
});

type RegisterFormValues = z.infer<typeof registerSchema>;

const Register = () => {
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const [showPassword, setShowPassword] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<RegisterFormValues>({
    resolver: zodResolver(registerSchema),
    defaultValues: { role: 'User' },
  });

  const onSubmit = async (data: RegisterFormValues) => {
    try {
      setApiError(null);
      setSuccessMsg(null);
      const response = await api.post('/auth/register', data);
      setSuccessMsg(response.data.message);
      setTimeout(() => navigate('/login'), 3000);
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
      <div className="hidden lg:flex lg:w-1/2 relative overflow-hidden items-center justify-center">
        
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
              Create Account
            </h2>
            <p className="mt-2 text-sm text-foreground/60">
              Register to join Events By Occasion
            </p>
          </div>

          <div className="bg-card py-8 px-4 shadow-xl shadow-black/5 sm:rounded-2xl sm:px-10 border border-border/50 animate-spring-up">
            {apiError && (
              <div className="bg-destructive/10 border border-destructive/20 text-destructive p-3 rounded-lg mb-6 text-sm text-center font-medium">
                {apiError}
              </div>
            )}

            {successMsg && (
              <div className="bg-accent/10 border border-accent/20 text-accent p-3 rounded-lg mb-6 text-sm text-center font-medium">
                {successMsg}
              </div>
            )}

            <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">
                  Full Name
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <User className="h-5 w-5 text-foreground/40" />
                  </div>
                  <input
                    type="text"
                    {...register('name')}
                    className={`block w-full pl-10 pr-3 py-2.5 border ${
                      errors.name ? 'border-destructive' : 'border-input'
                    } rounded-lg bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent transition-all sm:text-sm`}
                    placeholder="John Doe"
                  />
                </div>
                {errors.name && <p className="mt-1.5 text-sm text-destructive font-medium">{errors.name.message}</p>}
              </div>

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
                {errors.email && <p className="mt-1.5 text-sm text-destructive font-medium">{errors.email.message}</p>}
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
                {errors.password && <p className="mt-1.5 text-sm text-destructive font-medium">{errors.password.message}</p>}
              </div>

              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">
                  Role
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <Briefcase className="h-5 w-5 text-foreground/40" />
                  </div>
                  <select
                    {...register('role')}
                    className="block w-full pl-10 pr-3 py-2.5 border border-input rounded-lg bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent transition-all sm:text-sm appearance-none cursor-pointer"
                  >
                    <option value="User">User</option>
                    <option value="Admin">Admin</option>
                  </select>
                </div>
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full flex justify-center py-2.5 px-4 border border-transparent rounded-lg shadow-sm text-sm font-bold text-white bg-accent hover:bg-accent/90 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-accent disabled:opacity-50 disabled:cursor-not-allowed transition-all transform active:scale-[0.98] mt-2"
              >
                {isSubmitting ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  'Register'
                )}
              </button>

              <div className="text-center mt-6 text-sm">
                <span className="text-foreground/60">Already have an account? </span>
                <Link to="/login" className="font-bold text-accent hover:text-accent/80 transition-colors">
                  Sign in
                </Link>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Register;
