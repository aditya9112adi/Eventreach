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
    <div className="min-h-screen bg-background flex flex-col justify-center py-12 sm:px-6 lg:px-8">
      <div className="absolute top-4 right-4">
        <button
          onClick={toggleTheme}
          className="p-2 rounded-md text-foreground/60 hover:text-foreground hover:bg-foreground/5 transition-colors"
          title="Toggle Theme"
        >
          {theme === 'dark' ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
        </button>
      </div>

      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        <div className="flex justify-center mb-6">
          <img 
            src="/logo.png" 
            alt="Events By Occasion Logo" 
            className="w-48 h-auto max-h-48 object-contain drop-shadow-md" 
          />
        </div>
        <h2 className="text-center text-3xl font-extrabold text-foreground tracking-tight">
          Create Account
        </h2>
        <p className="mt-2 text-center text-sm text-foreground/60">
          Register to join Events By Occasion
        </p>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="bg-card py-8 px-4 shadow sm:rounded-lg sm:px-10 border border-border/50">
          {apiError && (
            <div className="bg-destructive/10 border border-destructive/20 text-destructive p-3 rounded-md mb-6 text-sm text-center">
              {apiError}
            </div>
          )}

          {successMsg && (
            <div className="bg-accent/10 border border-accent/20 text-accent p-3 rounded-md mb-6 text-sm text-center">
              {successMsg}
            </div>
          )}

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Full Name
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <User className="h-5 w-5 text-foreground/40" />
                </div>
                <input
                  type="text"
                  {...register('name')}
                  className={`block w-full pl-10 pr-3 py-2 border ${
                    errors.name ? 'border-destructive' : 'border-input'
                  } rounded-md bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent sm:text-sm`}
                  placeholder="John Doe"
                />
              </div>
              {errors.name && <p className="mt-1 text-sm text-destructive">{errors.name.message}</p>}
            </div>

            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Email Address
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Mail className="h-5 w-5 text-foreground/40" />
                </div>
                <input
                  type="email"
                  {...register('email')}
                  className={`block w-full pl-10 pr-3 py-2 border ${
                    errors.email ? 'border-destructive' : 'border-input'
                  } rounded-md bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent sm:text-sm`}
                  placeholder="name@company.com"
                />
              </div>
              {errors.email && <p className="mt-1 text-sm text-destructive">{errors.email.message}</p>}
            </div>

            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Password
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Lock className="h-5 w-5 text-foreground/40" />
                </div>
                <input
                  type={showPassword ? 'text' : 'password'}
                  {...register('password')}
                  className={`block w-full pl-10 pr-10 py-2 border ${
                    errors.password ? 'border-destructive' : 'border-input'
                  } rounded-md bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent sm:text-sm`}
                  placeholder="••••••••"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute inset-y-0 right-0 pr-3 flex items-center"
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4 text-foreground/40 hover:text-foreground" />
                  ) : (
                    <Eye className="h-4 w-4 text-foreground/40 hover:text-foreground" />
                  )}
                </button>
              </div>
              {errors.password && <p className="mt-1 text-sm text-destructive">{errors.password.message}</p>}
            </div>

            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Role
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Briefcase className="h-5 w-5 text-foreground/40" />
                </div>
                <select
                  {...register('role')}
                  className="block w-full pl-10 pr-3 py-2 border border-input rounded-md bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent sm:text-sm appearance-none"
                >
                  <option value="User">User</option>
                  <option value="Admin">Admin</option>
                </select>
              </div>
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-accent hover:bg-accent/90 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-accent disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isSubmitting ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                'Register'
              )}
            </button>

            <div className="text-center mt-4 text-sm">
              <span className="text-foreground/60">Already have an account? </span>
              <Link to="/login" className="font-medium text-accent hover:text-accent/80">
                Sign in
              </Link>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

export default Register;
