export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type Sleep = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

export type ProtocolEndpoints = {
  readonly deviceAuthorization: string;
  readonly token: string;
};

export type ProtocolDependencies = {
  readonly fetch: FetchLike;
  readonly monotonicNow: () => number;
  readonly sleep: Sleep;
  readonly endpoints: ProtocolEndpoints;
  readonly httpTimeoutMs: number;
  readonly maxResponseBytes: number;
};

export type DeviceAuthorization = {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  readonly expiresInSeconds: number;
  readonly intervalSeconds: number;
};

export type TokenGrant = {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresInSeconds: number;
};

export type RefreshGrant = {
  readonly accessToken: string;
  readonly refreshToken: string | undefined;
  readonly expiresInSeconds: number;
};

export type PollOptions = {
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ((message: string) => void) | undefined;
};

export type RequestOptions = {
  readonly signal?: AbortSignal | undefined;
};
