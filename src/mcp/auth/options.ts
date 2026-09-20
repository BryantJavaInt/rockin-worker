// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Bryant Giorgini

import { type Config, ConfigError } from '../../config/index.js';
import type { OAuthOptions } from './oauth.js';

const isLoopbackHost = (host: string) =>
  host === 'localhost' || host === '[::1]' || host.startsWith('127.');

/**
 * Tokens and key sets must travel over TLS: an authorization server reached over plain HTTP lets
 * anyone on the path substitute its keys and mint tokens this server would accept. Loopback is
 * exempt so a local authorization server can be used in development.
 */
function requireSecureUrl(name: string, value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw new ConfigError(
      `${name} must be an https:// URL (http:// is allowed only on localhost).`,
    );
  }
  if (url.hash) throw new ConfigError(`${name} must not contain a fragment.`);
  return url;
}

/**
 * The OAuth settings, or undefined when OAuth is not configured. Validated up front: a wrong
 * issuer or audience would otherwise show up only as every client being refused.
 */
export function oauthOptionsFrom(config: Config): OAuthOptions | undefined {
  const issuer = config.MCP_OAUTH_ISSUER;
  const audience = config.MCP_OAUTH_AUDIENCE;
  if (!issuer && !audience) return undefined;

  if (!issuer || !audience) {
    throw new ConfigError(
      'MCP_OAUTH_ISSUER and MCP_OAUTH_AUDIENCE must be set together: the issuer says who signs ' +
        'tokens, the audience says which resource they are for.',
    );
  }

  requireSecureUrl('MCP_OAUTH_ISSUER', issuer);
  const resource = requireSecureUrl('MCP_OAUTH_AUDIENCE', audience);
  if (resource.search) {
    throw new ConfigError('MCP_OAUTH_AUDIENCE must not contain a query string.');
  }
  if (config.MCP_OAUTH_JWKS_URI) requireSecureUrl('MCP_OAUTH_JWKS_URI', config.MCP_OAUTH_JWKS_URI);

  return {
    issuer,
    audience,
    scope: config.MCP_OAUTH_SCOPE,
    ...(config.MCP_OAUTH_JWKS_URI ? { jwksUri: config.MCP_OAUTH_JWKS_URI } : {}),
  };
}
