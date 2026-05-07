export interface TokenBundle {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  /** Absolute Unix epoch ms when the access token expires. */
  expiresAt: number;
  scope?: string;
}
