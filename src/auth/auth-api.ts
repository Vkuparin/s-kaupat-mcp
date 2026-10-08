import { SKaupatError } from "../errors.js";

/**
 * The two authenticated S-kaupat calls the login flow needs. Queries are sent
 * as plain text; the API accepts that without persisted-query hashes.
 *
 * Tokens are never logged. Errors carry only status codes and S-kaupat's
 * error codes, never request bodies or headers.
 */

export interface AuthTokens {
  accessToken: string;
  /** S-kaupat may rotate the refresh token on each refresh; null if it did not return one. */
  refreshToken: string | null;
}

export interface UserProfile {
  firstName: string | null;
  lastName: string | null;
}

export interface AuthApi {
  /** Exchanges a refresh token for fresh tokens. Throws session_expired when S-kaupat rejects it. */
  refresh(refreshToken: string): Promise<AuthTokens>;
  /** Throws session_expired when S-kaupat rejects the access token. */
  userProfile(accessToken: string): Promise<UserProfile>;
}

export interface HttpAuthApiOptions {
  apiUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const REFRESH_QUERY =
  "query GetRemoteAuthenticationTokens($refreshToken: String) { authTokens(refreshToken: $refreshToken) { accessToken idToken refreshToken } }";
const PROFILE_QUERY = "query UserProfileName { userProfile { firstName lastName } }";

const AUTH_ERROR_CODES = ["UNAUTHENTICATED", "UNAUTHORIZED", "FORBIDDEN"];

interface GraphQLBody {
  data?: Record<string, unknown> | null;
  errors?: { message?: string; extensions?: { code?: string } }[];
}

export class HttpAuthApi implements AuthApi {
  private readonly apiUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpAuthApiOptions = {}) {
    this.apiUrl = options.apiUrl ?? "https://api.s-kaupat.fi/";
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async refresh(refreshToken: string): Promise<AuthTokens> {
    const body = await this.post(REFRESH_QUERY, { refreshToken }, null);
    const tokens = body.data?.authTokens as { accessToken?: unknown; refreshToken?: unknown } | null | undefined;
    if (body.errors?.some((e) => e.extensions?.code === "GRAPHQL_VALIDATION_FAILED")) {
      // Our query no longer matches S-kaupat's schema: a server problem, not the user's login.
      throw new SKaupatError("upstream_error", `S-kaupat rejected the refresh query${errorSuffix(body)}.`);
    }
    if (!tokens || typeof tokens.accessToken !== "string" || !tokens.accessToken) {
      // Any refusal to hand out tokens means the stored login no longer works.
      throw new SKaupatError("session_expired", `S-kaupat did not renew the login${errorSuffix(body)}.`);
    }
    return {
      accessToken: tokens.accessToken,
      refreshToken: typeof tokens.refreshToken === "string" && tokens.refreshToken ? tokens.refreshToken : null,
    };
  }

  async userProfile(accessToken: string): Promise<UserProfile> {
    const body = await this.post(PROFILE_QUERY, {}, accessToken);
    if (body.errors?.some((e) => AUTH_ERROR_CODES.includes(e.extensions?.code ?? ""))) {
      throw new SKaupatError("session_expired", `S-kaupat rejected the access token${errorSuffix(body)}.`);
    }
    const profile = body.data?.userProfile as { firstName?: unknown; lastName?: unknown } | null | undefined;
    if (!profile) {
      throw new SKaupatError("upstream_error", `S-kaupat returned no user profile${errorSuffix(body)}.`);
    }
    return {
      firstName: typeof profile.firstName === "string" ? profile.firstName : null,
      lastName: typeof profile.lastName === "string" ? profile.lastName : null,
    };
  }

  private async post(query: string, variables: Record<string, unknown>, accessToken: string | null): Promise<GraphQLBody> {
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
    // The site sends the raw JWT, with no "Bearer" prefix.
    if (accessToken) headers.authorization = accessToken;
    const response = await this.fetchImpl(this.apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status === 401) {
      throw new SKaupatError("session_expired", "S-kaupat answered HTTP 401 to an authenticated call.");
    }
    if (response.status === 403 || response.status === 429) {
      throw new SKaupatError("blocked", `S-kaupat refused the request (HTTP ${response.status}).`);
    }
    if (response.status >= 500) {
      throw new SKaupatError("unavailable", `S-kaupat API returned HTTP ${response.status}.`);
    }
    const body = (await response.json().catch(() => null)) as GraphQLBody | null;
    if (!body || typeof body !== "object") {
      throw new SKaupatError("upstream_error", `S-kaupat API returned HTTP ${response.status} without JSON.`);
    }
    return body;
  }
}

function errorSuffix(body: GraphQLBody): string {
  const codes = (body.errors ?? []).map((e) => e.extensions?.code).filter(Boolean);
  return codes.length > 0 ? ` (${codes.join(", ")})` : "";
}
