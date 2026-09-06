import { Link } from 'react-router-dom';
import { ShieldCheck, KeyRound, Sun, Moon, ArrowLeft, Mail } from 'lucide-react';
import { useTheme } from '../store/themeStore';

/**
 * Account recovery guidance.
 *
 * This page deliberately does NOT reset a password. An account here is
 * identified only by its email address, which is also the login id and is
 * visible across the admin screens, and accounts carry no second factor (no
 * phone, no MFA, no security questions). A self-service "email + new password"
 * form would therefore let anyone take over any account, including a Super
 * Admin, in a single request.
 *
 * Recovery is instead performed by a Super Admin, who verifies the person
 * out-of-band and resets the password from Just Access.
 */
const ForgotPassword = () => {
  const { theme, toggleTheme } = useTheme();

  const steps = [
    {
      icon: Mail,
      title: 'Contact your Super Admin',
      body: 'Reach out through your usual internal channel and tell them which account is locked out.',
    },
    {
      icon: ShieldCheck,
      title: 'They confirm it is you',
      body: 'Identity is verified in person or over a trusted channel, not by anyone who simply knows your email address.',
    },
    {
      icon: KeyRound,
      title: 'They set a new password',
      body: 'The Super Admin resets it from Just Access. Sign in with the new password, then change it from the key icon in the sidebar.',
    },
  ];

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

      {/* Right Column */}
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
              Forgot Password?
            </h2>
            <p className="mt-2 text-sm text-foreground/60">
              Here is how to get back into your account securely.
            </p>
          </div>

          <div className="bg-card py-8 px-4 shadow-xl shadow-black/5 sm:rounded-2xl sm:px-10 border border-border/50 animate-spring-up">
            <ol className="space-y-6">
              {steps.map((step, index) => (
                <li key={step.title} className="flex gap-4">
                  <div className="flex-shrink-0 flex flex-col items-center">
                    <div className="w-10 h-10 rounded-full bg-accent/10 text-accent flex items-center justify-center">
                      <step.icon className="w-5 h-5" />
                    </div>
                    {index < steps.length - 1 && (
                      <div className="w-px flex-1 bg-border mt-2" aria-hidden="true" />
                    )}
                  </div>
                  <div className="pb-2">
                    <h3 className="text-sm font-bold text-foreground uppercase tracking-wide">
                      {step.title}
                    </h3>
                    <p className="mt-1 text-sm text-foreground/60 leading-relaxed">{step.body}</p>
                  </div>
                </li>
              ))}
            </ol>

            <div className="mt-8 pt-6 border-t border-border">
              <p className="text-xs text-foreground/50 leading-relaxed">
                <span className="font-bold text-foreground/70">Why not by email?</span> This
                application does not send password links, and an email address alone is not proof of
                identity. A Super Admin confirming who you are keeps your account, and everyone
                else&apos;s, from being reset by someone who merely knows your address.
              </p>
            </div>

            <Link
              to="/login"
              className="mt-8 w-full flex items-center justify-center gap-2 py-2.5 px-4 border border-transparent rounded-lg shadow-sm text-sm font-bold text-white bg-accent hover:bg-accent/90 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-accent transition-all transform active:scale-[0.98]"
            >
              <ArrowLeft className="w-4 h-4" />
              Back to Login
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ForgotPassword;
