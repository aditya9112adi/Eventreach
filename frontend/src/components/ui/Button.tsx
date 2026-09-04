import React from 'react';
import { Loader2 } from 'lucide-react';
import { motion } from 'framer-motion';
import type { HTMLMotionProps } from 'framer-motion';

interface ButtonProps extends HTMLMotionProps<"button"> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  isLoading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className = '', variant = 'primary', isLoading, children, disabled, ...props }, ref) => {
    
    // Note: removed CSS transition-all and active:scale because framer-motion handles it via spring physics now
    const baseStyles = "inline-flex items-center justify-center font-sans rounded-md font-medium transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-background disabled:opacity-50 disabled:pointer-events-none text-sm px-6 py-2.5";
    
    const variants = {
      primary: "bg-white text-black hover:bg-white/90 focus:ring-white",
      secondary: "bg-surface text-foreground border border-border hover:bg-surfaceHover focus:ring-surfaceHover",
      danger: "bg-destructive text-white hover:bg-destructive/90 focus:ring-destructive",
      ghost: "bg-transparent text-foreground hover:bg-surfaceHover focus:ring-surfaceHover"
    };

    return (
      <motion.button
        ref={ref}
        whileHover={disabled || isLoading ? undefined : { scale: 1.01 }}
        whileTap={disabled || isLoading ? undefined : { scale: 0.96 }}
        transition={{ type: "spring", stiffness: 400, damping: 25 }}
        className={`${baseStyles} ${variants[variant]} ${className}`}
        disabled={disabled || isLoading}
        {...props}
      >
        {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {children as React.ReactNode}
      </motion.button>
    );
  }
);
Button.displayName = 'Button';
