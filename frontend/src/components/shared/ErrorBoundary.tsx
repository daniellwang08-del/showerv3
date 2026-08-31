import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * App-wide error boundary. Without this, any render-time exception unmounts the
 * entire React tree and leaves the user staring at a blank white page. Here we
 * catch it, log it, and show a recoverable fallback with a reload action.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface to the console (and any attached monitoring) for diagnosis.
    console.error('Unhandled UI error:', error, info.componentStack);
  }

  private handleReload = () => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;

    return (
      <div
        role="alert"
        className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-50 p-6 text-center dark:bg-[#0b1220]"
      >
        <div className="max-w-md space-y-3">
          <h1 className="text-lg font-semibold text-slate-800 dark:text-slate-100">
            Something went wrong
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            The page hit an unexpected error. Reloading usually fixes it. If it keeps
            happening, please report it.
          </p>
          <button
            type="button"
            onClick={this.handleReload}
            className="mt-2 inline-flex items-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700"
          >
            Reload page
          </button>
        </div>
      </div>
    );
  }
}
