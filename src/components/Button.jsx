import React from 'react';
import { Icons } from './Icons';

const VARIANTS = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 shadow-sm shadow-brand-500/20 focus-visible:ring-brand-500',
  secondary: 'bg-white text-gray-700 border border-gray-200 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-200 dark:border-gray-600 dark:hover:bg-gray-700 focus-visible:ring-brand-500',
  danger: 'bg-red-600 text-white hover:bg-red-700 shadow-sm shadow-red-500/20 focus-visible:ring-red-500',
  ghost: 'bg-transparent text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700 focus-visible:ring-brand-500',
};

const SIZES = {
  sm: 'text-xs px-3 py-2',
  md: 'text-sm px-4 py-2.5',
  lg: 'text-sm px-5 py-3',
};

// 🟩 DESIGN SYSTEM: first reusable Button primitive in the app (every view
// previously hand-rolled its own Tailwind button classes). Not a forced
// migration of existing screens -- new work (Security settings, command
// palette additions, etc.) uses this so the app converges on one set of
// interaction states (hover/disabled/loading/focus-visible) instead of
// each screen inventing its own slightly-different variant.
const Button = React.forwardRef(({
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  className = '',
  children,
  ...rest
}, ref) => {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={`
        inline-flex items-center justify-center gap-2 rounded-xl font-bold
        transition-all duration-150 active:scale-[0.98]
        disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100
        focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900
        ${VARIANTS[variant] || VARIANTS.primary}
        ${SIZES[size] || SIZES.md}
        ${className}
      `}
      {...rest}
    >
      {loading && <span className="h-4 w-4 animate-spin inline-flex shrink-0">{Icons.Spinner}</span>}
      {children}
    </button>
  );
});
Button.displayName = 'Button';

export default Button;
