import { ReactNode } from 'react';
import { ErrorBoundary } from './ErrorBoundary';

interface LayoutProps {
  children: ReactNode;
}

export default function Layout({ children }: LayoutProps) {
  return (
    <ErrorBoundary>
      <div className="min-h-0 flex flex-col">
        {children}
      </div>
    </ErrorBoundary>
  );
}
