import React from 'react';
import { Loader2 } from 'lucide-react';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  isLoading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className = '', variant = 'primary', isLoading, children, disabled, ...props }, ref) => {
    
    const baseStyles = "inline-flex items-center justify-center font-sans rounded-md font-medium transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-background disabled:opacity-50 disabled:pointer-events-none text-sm px-6 py-2.5 active:scale-[0.98]";
    
    const variants = {
      primary: "bg-white text-black hover:bg-white/90 focus:ring-white",
      secondary: "bg-surface text-foreground border border-border hover:bg-surfaceHover focus:ring-surfaceHover",
      danger: "bg-destructive text-white hover:bg-destructive/90 focus:ring-destructive",
      ghost: "bg-transparent text-foreground hover:bg-surfaceHover focus:ring-surfaceHover"
    };

    return (
      <button
        ref={ref}
        className={`${baseStyles} ${variants[variant]} ${className}`}
        disabled={disabled || isLoading}
        {...props}
      >
        {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {children}
      </button>
    );
  }
);
Button.displayName = 'Button';
