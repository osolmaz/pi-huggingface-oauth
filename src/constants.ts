export const HUGGING_FACE_ORIGIN = "https://huggingface.co";
export const DEVICE_AUTHORIZATION_URL = `${HUGGING_FACE_ORIGIN}/oauth/device`;
export const TOKEN_URL = `${HUGGING_FACE_ORIGIN}/oauth/token`;
export const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
export const OAUTH_SCOPE = "inference-api";
export const DEFAULT_CLIENT_ID = "d5aeb161-93dc-4229-84ea-af58018c2ef0";
export const CLIENT_ID_ENV = "PI_HUGGINGFACE_OAUTH_CLIENT_ID";

export const DEFAULT_HTTP_TIMEOUT_MS = 15_000;
export const DEFAULT_POLL_INTERVAL_SECONDS = 5;
export const MAX_DEVICE_LIFETIME_SECONDS = 30 * 60;
export const MAX_POLL_INTERVAL_SECONDS = 60;
export const MAX_RESPONSE_BYTES = 32 * 1024;
export const MAX_ERROR_TEXT_LENGTH = 240;
export const MAX_TOKEN_LIFETIME_SECONDS = 366 * 24 * 60 * 60;
export const REFRESH_SKEW_MS = 5 * 60 * 1000;
export const REFRESH_RETRY_DELAYS_MS = [250, 500] as const;
