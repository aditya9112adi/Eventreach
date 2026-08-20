import React from 'react';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className = '', label, error, ...props }, ref) => {
    return (
      <div className="w-full">
        {label && (
          <label className="block text-sm font-sans text-foreground/80 mb-2">
            {label}
          </label>
        )}
        <input
          ref={ref}
          className={`
            w-full rounded-md border bg-surface/50 px-4 py-2.5 text-sm transition-all duration-200
            focus:outline-none focus:ring-2 focus:ring-white/20 focus:border-white/40 focus:bg-surface
            disabled:cursor-not-allowed disabled:opacity-50
            ${error 
              ? 'border-destructive focus:ring-destructive text-destructive placeholder-destructive/50' 
              : 'border-border text-foreground placeholder-foreground/30 hover:border-border/80'
            }
            ${className}
          `}
          {...props}
        />
        {error && (
          <p className="mt-1 text-sm text-red-600">{error}</p>
        )}
      </div>
    );
  }
);
Input.displayName = 'Input';
