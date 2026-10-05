// Minimal API-client shape the account pages call through. Hosts adapt
// their own HTTP client to it (ops `lib/api.ts`, tenant `lib/accountApi.ts`).

export interface AccountApiResponse<T> {
  success: boolean;
  data?:   T;
  error?:  string;
}

export interface AccountApiClient {
  get<T>(path: string):                  Promise<AccountApiResponse<T>>;
  patch<T>(path: string, body: unknown): Promise<AccountApiResponse<T>>;
  post<T>(path: string, body?: unknown): Promise<AccountApiResponse<T>>;
  delete<T>(path: string):               Promise<AccountApiResponse<T>>;
}
