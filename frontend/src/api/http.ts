import createClient from 'openapi-fetch';
import type { paths } from './schema';

/** Typed fetch client generated from the backend OpenAPI schema (`npm run gen:api`). */
export const http = createClient<paths>({
  baseUrl: '',
  credentials: 'include',
});

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Unwraps an openapi-fetch result, throwing an ApiError with the backend `detail`. */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.error !== undefined || result.data === undefined) {
    const detail =
      (result.error as { detail?: unknown } | undefined)?.detail ?? result.response.statusText;
    throw new ApiError(result.response.status, typeof detail === 'string' ? detail : 'Request failed');
  }
  return result.data;
}
