import { useState, useEffect, useCallback, useMemo, useRef, memo, type ReactNode } from 'react';

export type TooltipPosition = 'top' | 'bottom' | 'left' | 'right';

interface TooltipProps {
  readonly content: string | ReactNode;
  readonly children: ReactNode;
  readonly position?: TooltipPosition;
  readonly className?: string;
  readonly delay?: number;
}

interface HelpIconProps {
  readonly content: string | ReactNode;
  readonly className?: string;
}

const DEFAULT_POSITION: TooltipPosition = 'top';
const DEFAULT_DELAY = 200;
const DEFAULT_CLASSNAME = '';
const MIN_DELAY = 0;
const MAX_DELAY = 10000;
const MAX_CONTENT_LENGTH = 500;

const POSITION_CLASSES = {
  top: 'bottom-full left-1/2 transform -translate-x-1/2 mb-2',
  bottom: 'top-full left-1/2 transform -translate-x-1/2 mt-2',
  left: 'right-full top-1/2 transform -translate-y-1/2 mr-2',
  right: 'left-full top-1/2 transform -translate-y-1/2 ml-2',
} as const satisfies Record<TooltipPosition, string>;

const ARROW_CLASSES = {
  top: 'top-full left-1/2 transform -translate-x-1/2 border-t-gray-900 border-l-transparent border-r-transparent border-b-transparent',
  bottom: 'bottom-full left-1/2 transform -translate-x-1/2 border-b-gray-900 border-l-transparent border-r-transparent border-t-transparent',
  left: 'left-full top-1/2 transform -translate-y-1/2 border-l-gray-900 border-t-transparent border-b-transparent border-r-transparent',
  right: 'right-full top-1/2 transform -translate-y-1/2 border-r-gray-900 border-t-transparent border-b-transparent border-l-transparent',
} as const satisfies Record<TooltipPosition, string>;

const HELP_ICON_SVG = (
  <svg
    className="w-3 h-3 sm:w-4 sm:h-4"
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    aria-hidden="true"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
    />
  </svg>
);

const isTooltipPosition = (position: string | undefined): position is TooltipPosition => {
  return position === 'top' || position === 'bottom' || position === 'left' || position === 'right';
};

const validateDelay = (delay: number | undefined): number => {
  if (delay === undefined || delay === null) {
    return DEFAULT_DELAY;
  }
  if (typeof delay !== 'number' || !Number.isFinite(delay)) {
    return DEFAULT_DELAY;
  }
  if (delay < MIN_DELAY) {
    return MIN_DELAY;
  }
  if (delay > MAX_DELAY) {
    return MAX_DELAY;
  }
  return Math.floor(delay);
};

const validateClassName = (className: string | undefined): string => {
  if (!className || typeof className !== 'string') {
    return DEFAULT_CLASSNAME;
  }
  return className.trim();
};

const validateContent = (content: string | ReactNode): string | ReactNode => {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    if (trimmed.length === 0) {
      return '';
    }
    if (trimmed.length > MAX_CONTENT_LENGTH) {
      return trimmed.slice(0, MAX_CONTENT_LENGTH) + '...';
    }
    return trimmed;
  }
  return content;
};

const TooltipComponent = memo(function Tooltip({
  content,
  children,
  position = DEFAULT_POSITION,
  className = DEFAULT_CLASSNAME,
  delay = DEFAULT_DELAY,
}: TooltipProps): JSX.Element {
  const isMountedRef = useRef(true);
  const [isVisible, setIsVisible] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const validatedPosition = useMemo(
    () => (isTooltipPosition(position) ? position : DEFAULT_POSITION),
    [position],
  );
  const validatedDelay = useMemo(() => validateDelay(delay), [delay]);
  const validatedClassName = useMemo(() => validateClassName(className), [className]);
  const validatedContent = useMemo(() => validateContent(content), [content]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, []);

  const handleMouseEnter = useCallback(() => {
    if (!isMountedRef.current) {
      return;
    }

    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    timeoutRef.current = setTimeout(() => {
      if (isMountedRef.current) {
        setIsVisible(true);
      }
    }, validatedDelay);
  }, [validatedDelay]);

  const handleMouseLeave = useCallback(() => {
    if (!isMountedRef.current) {
      return;
    }

    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    setIsVisible(false);
  }, []);

  const positionClass = useMemo(
    () => POSITION_CLASSES[validatedPosition],
    [validatedPosition],
  );

  const arrowClass = useMemo(() => ARROW_CLASSES[validatedPosition], [validatedPosition]);

  const containerClassName = useMemo(
    () => `relative inline-block ${validatedClassName}`,
    [validatedClassName],
  );

  const tooltipClassName = useMemo(
    () => `absolute z-50 ${positionClass} pointer-events-none`,
    [positionClass],
  );

  const isStringContent = typeof validatedContent === 'string';

  return (
    <div
      className={containerClassName}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}
      {isVisible && (
        <div className={tooltipClassName} role="tooltip">
          <div className="bg-gray-900 text-white text-xs sm:text-sm rounded-lg shadow-xl px-3 py-2 max-w-md whitespace-normal">
            {isStringContent ? (
              <p className="leading-relaxed">{validatedContent}</p>
            ) : (
              validatedContent
            )}
            <div className={`absolute w-0 h-0 border-4 ${arrowClass}`} aria-hidden="true" />
          </div>
        </div>
      )}
    </div>
  );
});

export default TooltipComponent;

export const HelpIcon = memo(function HelpIcon({
  content,
  className = DEFAULT_CLASSNAME,
}: HelpIconProps): JSX.Element {
  const validatedClassName = useMemo(() => validateClassName(className), [className]);
  const validatedContent = useMemo(() => validateContent(content), [content]);

  return (
    <TooltipComponent content={validatedContent} className={validatedClassName}>
      <button
        type="button"
        className="inline-flex items-center justify-center w-4 h-4 sm:w-5 sm:h-5 rounded-full bg-gray-200 hover:bg-gray-300 text-gray-600 hover:text-gray-700 transition-colors focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-1"
        aria-label="Help"
      >
        {HELP_ICON_SVG}
      </button>
    </TooltipComponent>
  );
});
