// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

/** Who is calling, as established by the credential they presented. */
export type Principal = {
  kind: 'static' | 'oauth';
  /**
   * The stable identity that rate limits are counted against: the OAuth client when the token
   * names one, otherwise the subject; `static` for the shared bearer token.
   */
  id: string;
  subject?: string;
  clientId?: string;
  /** The token's unique id (`jti`), when it has one. */
  tokenId?: string;
  scopes: string[];
};

/**
 * Why a request was refused, in the vocabulary of RFC 6750 §3.1. `status` is what the HTTP
 * response uses; `outcome` is the low-cardinality label recorded in metrics.
 */
export class AuthError extends Error {
  override name = 'AuthError';

  constructor(
    readonly code:
      | 'invalid_request'
      | 'invalid_token'
      | 'insufficient_scope'
      | 'temporarily_unavailable',
    readonly status: 401 | 403 | 503,
    message: string,
    readonly outcome: string,
    /** For `insufficient_scope`: the scope the caller must obtain. */
    readonly scope?: string,
  ) {
    super(message);
  }
}

/** Turns a bearer credential into a Principal, or throws an AuthError. */
export interface Authenticator {
  authenticate(bearer: string | undefined): Promise<Principal>;
  /**
   * The `WWW-Authenticate` header for a refusal (RFC 6750 / RFC 9728). Called with no error when
   * the credential was simply absent.
   */
  challenge(error?: AuthError): string;
  /** RFC 9728 protected-resource metadata, when this authenticator has an authorization server. */
  metadata?: { paths: string[]; document: Record<string, unknown> };
}
