import { memo } from 'react';

interface LoadingSpinnerProps {
  readonly size?: 'small' | 'medium' | 'large';
  readonly label?: string;
}

type SpinnerSize = 'small' | 'medium' | 'large';

const SIZE_CLASSES = {
  small: 'w-4 h-4 border-2',
  medium: 'w-8 h-8 border-2',
  large: 'w-12 h-12 border-4',
} as const satisfies Record<SpinnerSize, string>;

const DEFAULT_SIZE: SpinnerSize = 'medium';
const DEFAULT_LABEL = 'Loading';
const MAX_LABEL_LENGTH = 200;

const isValidSize = (size: string | undefined): size is SpinnerSize => {
  return size === 'small' || size === 'medium' || size === 'large';
};

const validateLabel = (label: string | undefined): string | undefined => {
  if (label === undefined || label === null) {
    return undefined;
  }
  if (typeof label !== 'string') {
    return undefined;
  }
  const trimmed = label.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed.length > MAX_LABEL_LENGTH ? `${trimmed.substring(0, MAX_LABEL_LENGTH)}...` : trimmed;
};

export const LoadingSpinner = memo(function LoadingSpinner({
  size = DEFAULT_SIZE,
  label,
}: LoadingSpinnerProps): JSX.Element {
  const validSize = isValidSize(size) ? size : DEFAULT_SIZE;
  const validLabel = validateLabel(label);
  const ariaLabel = validLabel || DEFAULT_LABEL;
  const sizeClass = SIZE_CLASSES[validSize];

  return (
    <div
      className="flex flex-col items-center justify-center"
      role="status"
      aria-label={ariaLabel}
    >
      <div
        className={`${sizeClass} border-gray-200 border-t-blue-600 rounded-full animate-spin`}
        aria-hidden="true"
      />
      {validLabel && (
        <span className="mt-2 text-sm text-gray-600 sr-only">{validLabel}</span>
      )}
    </div>
  );
});
