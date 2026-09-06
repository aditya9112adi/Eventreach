import React from 'react';
import { Loader2 } from 'lucide-react';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'subtle';
export type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  isLoading?: boolean;
  /** Stretch to the width of the parent. */
  block?: boolean;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-primary text-primary-foreground hover:bg-primary-hover shadow-xs active:shadow-none',
  secondary:
    'bg-surface text-foreground border border-border hover:bg-surfaceHover hover:border-input shadow-xs',
  danger:
    'bg-destructive text-white hover:brightness-110 shadow-xs active:shadow-none',
  ghost:
    'bg-transparent text-foreground hover:bg-surfaceHover',
  subtle:
    'bg-primary/10 text-primary hover:bg-primary/15 dark:bg-primary/15 dark:hover:bg-primary/25',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5 rounded-md',
  md: 'h-9 px-4 text-sm gap-2 rounded-md',
  lg: 'h-11 px-5 text-md gap-2 rounded-lg',
};

/**
 * The application's single button.
 *
 * Motion is a CSS transition on transform/opacity rather than a spring library:
 * it is cheaper, respects prefers-reduced-motion through the global rule, and
 * keeps buttons usable inside lists without a component per row.
 */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className = '',
      variant = 'primary',
      size = 'md',
      isLoading = false,
      block = false,
      children,
      disabled,
      type = 'button',
      ...props
    },
    ref
  ) => {
    const inactive = disabled || isLoading;

    return (
      <button
        ref={ref}
        type={type}
        // Communicates the pending state to assistive tech, not just visually.
        aria-busy={isLoading || undefined}
        disabled={inactive}
        className={[
          'inline-flex items-center justify-center whitespace-nowrap font-medium',
          'transition-[background-color,border-color,color,box-shadow,transform]',
          'duration-control ease-out-expo',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          'disabled:opacity-55 disabled:pointer-events-none',
          inactive ? '' : 'active:translate-y-px',
          SIZES[size],
          VARIANTS[variant],
          block ? 'w-full' : '',
          className,
        ].join(' ')}
        {...props}
      >
        {isLoading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
        {children}
      </button>
    );
  }
);
Button.displayName = 'Button';

export default Button;
