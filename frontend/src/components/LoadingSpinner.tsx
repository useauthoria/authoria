import React from 'react';

interface LoadingSpinnerProps {
  readonly size?: 'small' | 'medium' | 'large';
  readonly label?: string;
}

export function LoadingSpinner({ size = 'medium', label }: LoadingSpinnerProps): JSX.Element {
  const sizeClasses = {
    small: 'w-4 h-4 border-2',
    medium: 'w-8 h-8 border-2',
    large: 'w-12 h-12 border-4',
  };

  return (
    <div className="flex flex-col items-center justify-center" role="status" aria-label={label || 'Loading'}>
      <div
        className={`${sizeClasses[size]} border-gray-200 border-t-blue-600 rounded-full animate-spin`}
        aria-hidden="true"
      />
      {label && (
        <span className="mt-2 text-sm text-gray-600 sr-only">{label}</span>
      )}
    </div>
  );
}

