// A tiny bridge so non-React code (the agent store) can trigger router
// navigation. `AppShell` registers the router's navigate function on mount.

type NavigateFn = (path: string) => void;

let _navigate: NavigateFn | null = null;

export function setAgentNavigator(fn: NavigateFn | null): void {
  _navigate = fn;
}

export function agentNavigate(path: string): void {
  if (_navigate) {
    _navigate(path);
  } else if (typeof window !== 'undefined' && window.location.pathname !== path) {
    window.location.assign(path);
  }
}
