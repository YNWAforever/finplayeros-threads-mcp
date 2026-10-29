export interface TokenRefreshResult {
  status: 'not-configured';
  message: string;
}

/**
 * Weekly cron entrypoint STUB for Task 1c. Future official API request:
 * GET https://graph.threads.com/refresh_access_token?grant_type=th_refresh_token
 * Supply the existing long-lived token securely; never log it or a token-bearing URL.
 * Tokens must be at least 24h old to refresh. Live OAuth, persistence and HTTP are out of scope.
 */
export async function refreshThreadsToken(): Promise<TokenRefreshResult> {
  return {
    status: 'not-configured',
    message: 'Token refresh not configured — awaiting Meta app + OAuth (Task 1c). No network request was made.',
  };
}
