import { type ReactNode } from 'react';
import { ErrorBoundary } from './ErrorBoundary';

interface LayoutProps {
  readonly children: ReactNode;
}

export default function Layout({ children }: LayoutProps): JSX.Element {
  return (
    <ErrorBoundary>
      <div className="min-h-0 flex flex-col">
        {children}
      </div>
    </ErrorBoundary>
  );
}
