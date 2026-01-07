import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import {
  getSupabaseClient,
  logger,
  UtilsError,
  SupabaseClientError,
  checkRateLimit,
  createCORSHeaders,
} from '../_shared/utils.ts';

interface DenoEnv {
  readonly get?: (key: string) => string | undefined;
}

interface DenoGlobal {
  readonly Deno?: {
    readonly env?: DenoEnv;
  };
}

interface OAuthResponse {
  readonly data?: unknown;
  readonly error?: string;
  readonly correlationId?: string;
}

interface TokenData {
  readonly access_token: string;
  readonly scope?: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
  readonly token_type?: string;
}

interface GoogleTokenData extends TokenData {
  readonly scope?: string;
}

interface ShopifyTokenData {
  readonly access_token: string;
  readonly scope: string;
}

interface ShopifyGraphQLResponse {
  readonly data?: {
    readonly shop?: {
      readonly id?: string;
    };
  };
}

interface IntegrationCredentials {
  access_token: string;
  refresh_token?: string;
  expires_at?: string;
  property_id?: string;
  site_url?: string;
}

type IntegrationType = 'google_analytics_4' | 'google_search_console';

const ENV_SUPABASE_URL = 'SUPABASE_URL' as const;
const ENV_SUPABASE_SERVICE_ROLE_KEY = 'SUPABASE_SERVICE_ROLE_KEY' as const;
const ENV_SHOPIFY_API_KEY = 'SHOPIFY_API_KEY' as const;
const ENV_SHOPIFY_API_SECRET = 'SHOPIFY_API_SECRET' as const;
const ENV_GOOGLE_CLIENT_ID = 'GOOGLE_CLIENT_ID' as const;
const ENV_GOOGLE_CLIENT_SECRET = 'GOOGLE_CLIENT_SECRET' as const;
const ENV_APP_URL = 'APP_URL' as const;
const ENV_CORS_ORIGINS = 'CORS_ORIGINS' as const;
const REQUIRED_SCOPES = [
  'read_content',
  'write_content',
  'read_products',
  'read_orders',
  'read_customers',
] as const;
const GOOGLE_OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth' as const;
const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token' as const;
const GA4_SCOPES = 'https://www.googleapis.com/auth/analytics.readonly' as const;
const GSC_SCOPES = 'https://www.googleapis.com/auth/webmasters.readonly' as const;
const METHOD_GET = 'GET' as const;
const METHOD_POST = 'POST' as const;
const METHOD_OPTIONS = 'OPTIONS' as const;
const STATUS_OK = 200;
const STATUS_BAD_REQUEST = 400;
const STATUS_UNAUTHORIZED = 401;
const STATUS_NOT_FOUND = 404;
const STATUS_TOO_MANY_REQUESTS = 429;
const STATUS_INTERNAL_ERROR = 500;
const STATUS_NO_CONTENT = 204;
const HEADER_CONTENT_TYPE = 'Content-Type' as const;
const HEADER_CONTENT_TYPE_JSON = 'application/json' as const;
const HEADER_CONTENT_TYPE_HTML = 'text/html' as const;
const HEADER_X_CORRELATION_ID = 'x-correlation-id' as const;
const CORRELATION_PREFIX = 'oauth-' as const;
const ID_RADIX = 36;
const ID_LENGTH = 9;
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_AUTHORIZE_MAX = 20;
const RATE_LIMIT_REFRESH_MAX = 10;
const OAUTH_SESSION_EXPIRY_MS = 10 * 60 * 1000;
const SHOPIFY_GRAPHQL_API_VERSION = '2024-01' as const;
const REDIRECT_STATUS = 302;
const ERROR_CODE_OAUTH_ERROR = 'OAUTH_ERROR' as const;
const ERROR_CODE_CONFIG_ERROR = 'CONFIG_ERROR' as const;
const ERROR_CODE_DATABASE_ERROR = 'DATABASE_ERROR' as const;
const ERROR_RATE_LIMIT_EXCEEDED = 'Rate limit exceeded. Please try again later.' as const;
const ERROR_SHOP_REQUIRED = 'Shop parameter is required' as const;
const ERROR_INVALID_SHOP_DOMAIN = 'Invalid shop domain format' as const;
const ERROR_INVALID_HMAC = 'Invalid HMAC signature' as const;
const ERROR_MISSING_PARAMETERS = 'Missing required parameters' as const;
const ERROR_INVALID_SESSION = 'Invalid or expired OAuth session' as const;
const ERROR_SESSION_EXPIRED = 'OAuth session expired' as const;
const ERROR_TOKEN_EXCHANGE_FAILED = 'Failed to exchange code for token' as const;
const ERROR_MISSING_SCOPES = 'Missing required scopes' as const;
const ERROR_STORE_NOT_FOUND = 'Store not found' as const;
const ERROR_SHOP_DOMAIN_REQUIRED = 'Valid shop_domain parameter is required' as const;
const ERROR_STORE_ID_REQUIRED = 'storeId and integrationType are required' as const;
const ERROR_INVALID_INTEGRATION_TYPE = 'integrationType must be google_analytics_4 or google_search_console' as const;
const ERROR_CODE_STATE_REQUIRED = 'code and state are required' as const;
const ERROR_INTEGRATION_NOT_FOUND = 'Integration not found' as const;
const ERROR_NO_REFRESH_TOKEN = 'No refresh token available. Please reconnect the integration.' as const;
const ERROR_TOKEN_REFRESH_FAILED = 'Failed to refresh token' as const;
const ERROR_TOKEN_UPDATE_FAILED = 'Failed to update token' as const;
const ERROR_NOT_FOUND = 'Not found' as const;
const ERROR_INTERNAL_SERVER = 'Internal server error' as const;
const ERROR_OAUTH_FAILED = 'oauth_failed' as const;
const CHARS_DEFAULT = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789' as const;
const CHARS_GOOGLE_STATE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~' as const;
const CODE_VERIFIER_LENGTH = 128;
const STATE_LENGTH = 32;
const SHOPIFY_ID_REGEX = /\/(\d+)$/;

function getEnv(key: string, defaultValue = ''): string {
  try {
    const deno = (globalThis as DenoGlobal).Deno;
    return deno?.env?.get?.(key) ?? defaultValue;
  } catch {
    return defaultValue;
  }
}

const CONFIG = {
  SUPABASE_URL: getEnv(ENV_SUPABASE_URL, ''),
  SUPABASE_SERVICE_ROLE_KEY: getEnv(ENV_SUPABASE_SERVICE_ROLE_KEY, ''),
  SHOPIFY_API_KEY: getEnv(ENV_SHOPIFY_API_KEY, ''),
  SHOPIFY_API_SECRET: getEnv(ENV_SHOPIFY_API_SECRET, ''),
  GOOGLE_CLIENT_ID: getEnv(ENV_GOOGLE_CLIENT_ID, ''),
  GOOGLE_CLIENT_SECRET: getEnv(ENV_GOOGLE_CLIENT_SECRET, ''),
  APP_URL: getEnv(ENV_APP_URL, ''),
  CORS_ORIGINS: getEnv(ENV_CORS_ORIGINS, '*').split(','),
} as const;

function generateCorrelationId(): string {
  return `${CORRELATION_PREFIX}${Date.now()}-${Math.random().toString(ID_RADIX).substring(2, 2 + ID_LENGTH)}`;
}

function getCORSHeaders(req: Request): Readonly<Record<string, string>> {
  return createCORSHeaders(req, CONFIG.CORS_ORIGINS);
}

function createSuccessResponse(
  data: unknown,
  correlationId: string,
  request: Request,
): Response {
  const response: OAuthResponse = {
    data,
    correlationId,
  };

  return new Response(JSON.stringify(response), {
    status: STATUS_OK,
    headers: {
      ...getCORSHeaders(request),
      [HEADER_CONTENT_TYPE]: HEADER_CONTENT_TYPE_JSON,
      [HEADER_X_CORRELATION_ID]: correlationId,
    },
  });
}

function createErrorResponse(
  error: string,
  status: number,
  correlationId: string,
  request: Request,
): Response {
  const response: OAuthResponse = {
    error,
    correlationId,
  };

  return new Response(JSON.stringify(response), {
    status,
    headers: {
      ...getCORSHeaders(request),
      [HEADER_CONTENT_TYPE]: HEADER_CONTENT_TYPE_JSON,
      [HEADER_X_CORRELATION_ID]: correlationId,
    },
  });
}

function createHTMLResponse(
  html: string,
  correlationId: string,
  request: Request,
): Response {
  return new Response(html, {
    status: STATUS_OK,
    headers: {
      ...getCORSHeaders(request),
      [HEADER_CONTENT_TYPE]: HEADER_CONTENT_TYPE_HTML,
      [HEADER_X_CORRELATION_ID]: correlationId,
    },
  });
}

function generateRandomString(length: number, chars: string = CHARS_DEFAULT): string {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function generateCodeVerifier(): string {
  return generateRandomString(CODE_VERIFIER_LENGTH);
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashBase64 = btoa(String.fromCharCode(...hashArray))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  return hashBase64;
}

function validateShopDomain(shop: string): boolean {
  const shopRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;
  return shopRegex.test(shop);
}

function normalizeShopDomain(shop: string): string {
  let domain = shop.toLowerCase().trim();
  if (!domain.endsWith('.myshopify.com')) {
    domain = `${domain}.myshopify.com`;
  }
  return domain;
}

async function verifyHmac(query: URLSearchParams, secret: string): Promise<boolean> {
  const hmac = query.get('hmac');
  if (!hmac) return false;

  const params = new URLSearchParams(query);
  params.delete('hmac');

  const sortedParams = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const messageData = encoder.encode(sortedParams);
  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, messageData);
  const hashArray = Array.from(new Uint8Array(signature));
  const calculatedHmac = btoa(String.fromCharCode(...hashArray))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  return hmac === calculatedHmac;
}

function createOAuthErrorHTML(error: string, correlationId: string): string {
  const errorEscaped = error.replace(/'/g, "\\'").replace(/"/g, '&quot;');
  const appUrl = CONFIG.APP_URL.replace(/'/g, "\\'");
  return `<!DOCTYPE html>
<html>
<head>
  <title>OAuth Error</title>
</head>
<body>
  <script>
    if (window.opener) {
      window.opener.postMessage({
        type: 'oauth-error',
        error: ${JSON.stringify(error)},
        success: false
      }, '*');
      window.close();
    } else {
      window.location.href = ${JSON.stringify(`${appUrl}/settings?error=oauth_${error}`)};
    }
  </script>
  <p>Authorization failed: ${errorEscaped}. You can close this window.</p>
</body>
</html>`;
}

function createOAuthSuccessHTML(integrationType: string, correlationId: string): string {
  const integrationTypeEscaped = integrationType.replace(/'/g, "\\'");
  const appUrl = CONFIG.APP_URL.replace(/'/g, "\\'");
  return `<!DOCTYPE html>
<html>
<head>
  <title>OAuth Success</title>
</head>
<body>
  <script>
    if (window.opener) {
      window.opener.postMessage({
        type: 'oauth-success',
        integrationType: ${JSON.stringify(integrationTypeEscaped)},
        success: true
      }, '*');
      window.close();
    } else {
      window.location.href = ${JSON.stringify(`${appUrl}/settings?connected=${integrationTypeEscaped}`)};
    }
  </script>
  <p>Authorization successful! You can close this window.</p>
</body>
</html>`;
}

async function handleShopifyAuthorize(req: Request): Promise<Response> {
  const correlationId = req.headers.get(HEADER_X_CORRELATION_ID) ?? generateCorrelationId();
  const rateLimit = checkRateLimit('oauth:shopify:authorize', RATE_LIMIT_AUTHORIZE_MAX, RATE_LIMIT_WINDOW_MS);
  if (!rateLimit.allowed) {
    return createErrorResponse(ERROR_RATE_LIMIT_EXCEEDED, STATUS_TOO_MANY_REQUESTS, correlationId, req);
  }

  const url = new URL(req.url);
  const shop = url.searchParams.get('shop');

  if (!shop) {
    return createErrorResponse(ERROR_SHOP_REQUIRED, STATUS_BAD_REQUEST, correlationId, req);
  }

  const shopDomain = normalizeShopDomain(shop);
  if (!validateShopDomain(shopDomain)) {
    return createErrorResponse(ERROR_INVALID_SHOP_DOMAIN, STATUS_BAD_REQUEST, correlationId, req);
  }

  try {
    const supabase = await getSupabaseClient({ clientType: 'service' });

    const state = generateRandomString(STATE_LENGTH);
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    const redirectUri = `${CONFIG.APP_URL}/auth/callback`;
    const scopes = REQUIRED_SCOPES.join(',');

    const expiresAt = new Date(Date.now() + OAUTH_SESSION_EXPIRY_MS);
    const { error: sessionError } = await supabase.from('oauth_sessions').insert({
      state,
      provider: 'shopify',
      shop_domain: shopDomain,
      code_verifier: codeVerifier,
      scopes: REQUIRED_SCOPES,
      redirect_uri: redirectUri,
      expires_at: expiresAt.toISOString(),
    });

    if (sessionError) {
      logger.error('Failed to store OAuth session', { correlationId, error: sessionError });
      throw new UtilsError('Failed to initialize OAuth', ERROR_CODE_OAUTH_ERROR as string, STATUS_INTERNAL_ERROR);
    }

    const authUrl = new URL(`https://${shopDomain}/admin/oauth/authorize`);
    authUrl.searchParams.set('client_id', CONFIG.SHOPIFY_API_KEY);
    authUrl.searchParams.set('scope', scopes);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    return createSuccessResponse(
      {
        authUrl: authUrl.toString(),
        state,
      },
      correlationId,
      req,
    );
  } catch (error) {
    logger.error('OAuth authorize error', {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
      shop: shopDomain,
    });
    return createErrorResponse(
      error instanceof Error ? error.message : ERROR_INTERNAL_SERVER,
      error instanceof UtilsError ? error.statusCode : STATUS_INTERNAL_ERROR,
      correlationId,
      req,
    );
  }
}

async function handleShopifyCallback(req: Request): Promise<Response> {
  const correlationId = req.headers.get(HEADER_X_CORRELATION_ID) ?? generateCorrelationId();
  const url = new URL(req.url);
  const query = url.searchParams;

  if (!(await verifyHmac(new URLSearchParams(query), CONFIG.SHOPIFY_API_SECRET))) {
    return createErrorResponse(ERROR_INVALID_HMAC, STATUS_UNAUTHORIZED, correlationId, req);
  }

  const shop = query.get('shop');
  const code = query.get('code');
  const state = query.get('state');

  if (!shop || !code || !state) {
    return createErrorResponse(ERROR_MISSING_PARAMETERS, STATUS_BAD_REQUEST, correlationId, req);
  }

  const shopDomain = normalizeShopDomain(shop);

  try {
    const supabase = await getSupabaseClient({ clientType: 'service' });

    const { data: session, error: sessionError } = await supabase
      .from('oauth_sessions')
      .select('*')
      .eq('state', state)
      .eq('provider', 'shopify')
      .eq('shop_domain', shopDomain)
      .single();

    if (sessionError || !session) {
      logger.error('OAuth session not found', { correlationId, state, shopDomain, error: sessionError });
      return createErrorResponse(ERROR_INVALID_SESSION, STATUS_UNAUTHORIZED, correlationId, req);
    }

    if (new Date(session.expires_at) < new Date()) {
      return createErrorResponse(ERROR_SESSION_EXPIRED, STATUS_UNAUTHORIZED, correlationId, req);
    }

    const tokenUrl = `https://${shopDomain}/admin/oauth/access_token`;
    const tokenResponse = await fetch(tokenUrl, {
      method: METHOD_POST,
      headers: { [HEADER_CONTENT_TYPE]: HEADER_CONTENT_TYPE_JSON },
      body: JSON.stringify({
        client_id: CONFIG.SHOPIFY_API_KEY,
        client_secret: CONFIG.SHOPIFY_API_SECRET,
        code,
        code_verifier: session.code_verifier,
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      logger.error('Token exchange failed', { correlationId, shopDomain, error: errorText });
      throw new UtilsError(ERROR_TOKEN_EXCHANGE_FAILED, ERROR_CODE_OAUTH_ERROR as string, STATUS_INTERNAL_ERROR);
    }

    const tokenData = (await tokenResponse.json()) as ShopifyTokenData;

    let shopifyStoreId: bigint | null = null;
    try {
      const graphqlUrl = `https://${shopDomain}/admin/api/${SHOPIFY_GRAPHQL_API_VERSION}/graphql.json`;
      const graphqlResponse = await fetch(graphqlUrl, {
        method: METHOD_POST,
        headers: {
          [HEADER_CONTENT_TYPE]: HEADER_CONTENT_TYPE_JSON,
          'X-Shopify-Access-Token': tokenData.access_token,
        },
        body: JSON.stringify({
          query: `
            query {
              shop {
                id
                name
                myshopifyDomain
              }
            }
          `,
        }),
      });

      if (graphqlResponse.ok) {
        const graphqlData = (await graphqlResponse.json()) as ShopifyGraphQLResponse;

        if (graphqlData.data?.shop?.id) {
          const shopGid = graphqlData.data.shop.id;
          const idMatch = shopGid.match(SHOPIFY_ID_REGEX);
          if (idMatch && idMatch[1]) {
            shopifyStoreId = BigInt(idMatch[1]);
          }
        }
      }
    } catch (error) {
      logger.warn('Error fetching Shopify Shop ID', {
        correlationId,
        shopDomain,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const { data: existingStore } = await supabase
      .from('stores')
      .select('id')
      .eq('shop_domain', shopDomain)
      .single();

    const scopes = tokenData.scope.split(',').map((s) => s.trim());
    const missingScopes = REQUIRED_SCOPES.filter((scope) => !scopes.includes(scope));
    if (missingScopes.length > 0) {
      return createErrorResponse(
        `${ERROR_MISSING_SCOPES}: ${missingScopes.join(', ')}`,
        STATUS_BAD_REQUEST,
        correlationId,
        req,
      );
    }

    if (existingStore) {
      const updateData: Record<string, unknown> = {
        access_token: tokenData.access_token,
        oauth_scopes: scopes,
        installed_at: new Date().toISOString(),
        uninstalled_at: null,
        is_active: true,
        updated_at: new Date().toISOString(),
      };

      if (shopifyStoreId !== null) {
        updateData.shopify_store_id = shopifyStoreId.toString();
      }

      const { error: updateError } = await supabase
        .from('stores')
        .update(updateData)
        .eq('id', existingStore.id);

      if (updateError) {
        throw new SupabaseClientError('Failed to update store', updateError);
      }

      await supabase.rpc('complete_onboarding_step', {
        p_store_id: existingStore.id,
        p_step_name: 'oauth',
      });
    } else {
      const { data: plan } = await supabase
        .from('plan_limits')
        .select('id')
        .eq('plan_name', 'free_trial')
        .single();

      if (!plan) {
        throw new UtilsError('Free trial plan not found', ERROR_CODE_CONFIG_ERROR as string, STATUS_INTERNAL_ERROR);
      }

      const insertData: Record<string, unknown> = {
        shop_domain: shopDomain,
        access_token: tokenData.access_token,
        oauth_scopes: scopes,
        plan_id: plan.id,
        installed_at: new Date().toISOString(),
        is_active: true,
      };

      if (shopifyStoreId !== null) {
        insertData.shopify_store_id = shopifyStoreId.toString();
      }

      const { data: newStore, error: createError } = await supabase
        .from('stores')
        .insert(insertData)
        .select()
        .single();

      if (createError || !newStore) {
        throw new SupabaseClientError('Failed to create store', createError);
      }

      await supabase.rpc('complete_onboarding_step', {
        p_store_id: newStore.id,
        p_step_name: 'oauth',
      });
    }

    await supabase.from('oauth_sessions').delete().eq('state', state);

    return Response.redirect(`${CONFIG.APP_URL}?shop=${shopDomain}&installed=true`, REDIRECT_STATUS);
  } catch (error) {
    logger.error('OAuth callback error', {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
      shop: shopDomain,
    });
    return createErrorResponse(
      error instanceof Error ? error.message : ERROR_INTERNAL_SERVER,
      error instanceof UtilsError ? error.statusCode : STATUS_INTERNAL_ERROR,
      correlationId,
      req,
    );
  }
}

async function handleShopifyRefresh(req: Request): Promise<Response> {
  const correlationId = req.headers.get(HEADER_X_CORRELATION_ID) ?? generateCorrelationId();
  const rateLimit = checkRateLimit('oauth:shopify:refresh', RATE_LIMIT_REFRESH_MAX, RATE_LIMIT_WINDOW_MS);
  if (!rateLimit.allowed) {
    return createErrorResponse(ERROR_RATE_LIMIT_EXCEEDED, STATUS_TOO_MANY_REQUESTS, correlationId, req);
  }

  const url = new URL(req.url);
  const shopDomain = url.searchParams.get('shop_domain');

  if (!shopDomain || !validateShopDomain(normalizeShopDomain(shopDomain))) {
    return createErrorResponse(ERROR_SHOP_DOMAIN_REQUIRED, STATUS_BAD_REQUEST, correlationId, req);
  }

  const normalizedDomain = normalizeShopDomain(shopDomain);

  try {
    const supabase = await getSupabaseClient({ clientType: 'service' });

    const { data: store, error: storeError } = await supabase
      .from('stores')
      .select('id, shop_domain, is_active')
      .eq('shop_domain', normalizedDomain)
      .single();

    if (storeError || !store) {
      return createErrorResponse(ERROR_STORE_NOT_FOUND, STATUS_NOT_FOUND, correlationId, req);
    }

    const authUrl = new URL(`https://${normalizedDomain}/admin/oauth/authorize`);
    authUrl.searchParams.set('client_id', CONFIG.SHOPIFY_API_KEY);
    authUrl.searchParams.set('scope', REQUIRED_SCOPES.join(','));
    authUrl.searchParams.set('redirect_uri', `${CONFIG.APP_URL}/auth/callback`);

    return createSuccessResponse(
      {
        message: 'Re-authentication required. Please authorize the application.',
        authUrl: authUrl.toString(),
        shopDomain: normalizedDomain,
      },
      correlationId,
      req,
    );
  } catch (error) {
    logger.error('Token refresh error', {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
      shopDomain: normalizedDomain,
    });
    return createErrorResponse(
      error instanceof Error ? error.message : ERROR_INTERNAL_SERVER,
      error instanceof UtilsError ? error.statusCode : STATUS_INTERNAL_ERROR,
      correlationId,
      req,
    );
  }
}

async function handleGoogleAuthorize(req: Request): Promise<Response> {
  const correlationId = req.headers.get(HEADER_X_CORRELATION_ID) ?? generateCorrelationId();
  const url = new URL(req.url);
  const storeId = url.searchParams.get('storeId');
  const integrationType = url.searchParams.get('integrationType') as IntegrationType | null;
  const propertyId = url.searchParams.get('propertyId');
  const siteUrl = url.searchParams.get('siteUrl');

  if (!storeId || !integrationType) {
    return createErrorResponse(ERROR_STORE_ID_REQUIRED, STATUS_BAD_REQUEST, correlationId, req);
  }

  if (integrationType !== 'google_analytics_4' && integrationType !== 'google_search_console') {
    return createErrorResponse(ERROR_INVALID_INTEGRATION_TYPE, STATUS_BAD_REQUEST, correlationId, req);
  }

  try {
    const supabase = await getSupabaseClient({ clientType: 'service' });

    const state = generateRandomString(STATE_LENGTH, CHARS_GOOGLE_STATE);
    const redirectUri = `${CONFIG.APP_URL}/functions/v1/oauth/google/callback`;
    const scopes = integrationType === 'google_analytics_4' ? GA4_SCOPES : GSC_SCOPES;

    const expiresAt = new Date(Date.now() + OAUTH_SESSION_EXPIRY_MS);

    const { error: sessionError } = await supabase.from('oauth_sessions').insert({
      state,
      provider: 'google',
      store_id: storeId,
      integration_type: integrationType,
      property_id: propertyId || null,
      site_url: siteUrl || null,
      expires_at: expiresAt.toISOString(),
    });

    if (sessionError) {
      logger.error('Failed to store OAuth session', { correlationId, error: sessionError });
      throw new UtilsError('Failed to initialize OAuth', ERROR_CODE_OAUTH_ERROR as string, STATUS_INTERNAL_ERROR);
    }

    const authUrl = new URL(GOOGLE_OAUTH_AUTH_URL);
    authUrl.searchParams.set('client_id', CONFIG.GOOGLE_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', scopes);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');

    return createSuccessResponse({ authUrl: authUrl.toString() }, correlationId, req);
  } catch (error) {
    logger.error('OAuth authorize error', {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return createErrorResponse(
      error instanceof Error ? error.message : ERROR_INTERNAL_SERVER,
      error instanceof UtilsError ? error.statusCode : STATUS_INTERNAL_ERROR,
      correlationId,
      req,
    );
  }
}

async function handleGoogleCallback(req: Request): Promise<Response> {
  const correlationId = req.headers.get(HEADER_X_CORRELATION_ID) ?? generateCorrelationId();
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    return createHTMLResponse(createOAuthErrorHTML(error, correlationId), correlationId, req);
  }

  if (!code || !state) {
    return createErrorResponse(ERROR_CODE_STATE_REQUIRED, STATUS_BAD_REQUEST, correlationId, req);
  }

  try {
    const supabase = await getSupabaseClient({ clientType: 'service' });

    const { data: session, error: sessionError } = await supabase
      .from('oauth_sessions')
      .select('*')
      .eq('state', state)
      .eq('provider', 'google')
      .single();

    if (sessionError || !session) {
      logger.error('OAuth session not found', { correlationId, state, error: sessionError });
      return createErrorResponse(ERROR_INVALID_SESSION, STATUS_UNAUTHORIZED, correlationId, req);
    }

    if (new Date(session.expires_at) < new Date()) {
      return createErrorResponse(ERROR_SESSION_EXPIRED, STATUS_UNAUTHORIZED, correlationId, req);
    }

    const redirectUri = `${CONFIG.APP_URL}/functions/v1/oauth/google/callback`;

    const tokenResponse = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
      method: METHOD_POST,
      headers: {
        [HEADER_CONTENT_TYPE]: 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: CONFIG.GOOGLE_CLIENT_ID,
        client_secret: CONFIG.GOOGLE_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      logger.error('Token exchange failed', { correlationId, error: errorText });
      throw new UtilsError(ERROR_TOKEN_EXCHANGE_FAILED, ERROR_CODE_OAUTH_ERROR as string, STATUS_INTERNAL_ERROR);
    }

    const tokenData = (await tokenResponse.json()) as GoogleTokenData;

    const credentials: IntegrationCredentials = {
      access_token: tokenData.access_token,
    };

    if (tokenData.refresh_token) {
      credentials.refresh_token = tokenData.refresh_token;
    }

    if (tokenData.expires_in) {
      const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000);
      credentials.expires_at = expiresAt.toISOString();
    }

    if (session.property_id) {
      credentials.property_id = session.property_id;
    }

    if (session.site_url) {
      credentials.site_url = session.site_url;
    }

    const { error: upsertError } = await supabase
      .from('analytics_integrations')
      .upsert(
        {
          store_id: session.store_id,
          integration_type: session.integration_type,
          credentials,
          is_active: true,
          last_sync_at: null,
        },
        {
          onConflict: 'store_id,integration_type',
        },
      );

    if (upsertError) {
      logger.error('Failed to save integration', { correlationId, error: upsertError });
      throw new UtilsError('Failed to save integration', ERROR_CODE_DATABASE_ERROR as string, STATUS_INTERNAL_ERROR);
    }

    await supabase.from('oauth_sessions').delete().eq('state', state).eq('provider', 'google');

    return createHTMLResponse(createOAuthSuccessHTML(session.integration_type, correlationId), correlationId, req);
  } catch (error) {
    logger.error('OAuth callback error', {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
    });
    const errorMessage = error instanceof Error ? error.message : ERROR_INTERNAL_SERVER;
    return createHTMLResponse(createOAuthErrorHTML(ERROR_OAUTH_FAILED, correlationId), correlationId, req);
  }
}

async function handleGoogleRefresh(req: Request): Promise<Response> {
  const correlationId = req.headers.get(HEADER_X_CORRELATION_ID) ?? generateCorrelationId();
  const url = new URL(req.url);
  const storeId = url.searchParams.get('storeId');
  const integrationType = url.searchParams.get('integrationType') as IntegrationType | null;

  if (!storeId || !integrationType) {
    return createErrorResponse(ERROR_STORE_ID_REQUIRED, STATUS_BAD_REQUEST, correlationId, req);
  }

  try {
    const supabase = await getSupabaseClient({ clientType: 'service' });

    const { data: integration, error: integrationError } = await supabase
      .from('analytics_integrations')
      .select('credentials')
      .eq('store_id', storeId)
      .eq('integration_type', integrationType)
      .single();

    if (integrationError || !integration) {
      return createErrorResponse(ERROR_INTEGRATION_NOT_FOUND, STATUS_BAD_REQUEST, correlationId, req);
    }

    const credentials = integration.credentials as {
      readonly refresh_token?: string;
    };

    if (!credentials.refresh_token) {
      return createErrorResponse(ERROR_NO_REFRESH_TOKEN, STATUS_BAD_REQUEST, correlationId, req);
    }

    const tokenResponse = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
      method: METHOD_POST,
      headers: {
        [HEADER_CONTENT_TYPE]: 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: CONFIG.GOOGLE_CLIENT_ID,
        client_secret: CONFIG.GOOGLE_CLIENT_SECRET,
        refresh_token: credentials.refresh_token,
        grant_type: 'refresh_token',
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      logger.error('Token refresh failed', { correlationId, error: errorText });
      return createErrorResponse(ERROR_TOKEN_REFRESH_FAILED, STATUS_INTERNAL_ERROR, correlationId, req);
    }

    const tokenData = (await tokenResponse.json()) as GoogleTokenData;

    const updatedCredentials: IntegrationCredentials = {
      ...credentials,
      access_token: tokenData.access_token,
    };

    if (tokenData.expires_in) {
      const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000);
      updatedCredentials.expires_at = expiresAt.toISOString();
    }

    const { error: updateError } = await supabase
      .from('analytics_integrations')
      .update({ credentials: updatedCredentials })
      .eq('store_id', storeId)
      .eq('integration_type', integrationType);

    if (updateError) {
      logger.error('Failed to update token', { correlationId, error: updateError });
      return createErrorResponse(ERROR_TOKEN_UPDATE_FAILED, STATUS_INTERNAL_ERROR, correlationId, req);
    }

    return createSuccessResponse({ success: true }, correlationId, req);
  } catch (error) {
    logger.error('Refresh token error', {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return createErrorResponse(
      error instanceof Error ? error.message : ERROR_INTERNAL_SERVER,
      error instanceof UtilsError ? error.statusCode : STATUS_INTERNAL_ERROR,
      correlationId,
      req,
    );
  }
}

async function routeRequest(req: Request): Promise<Response> {
  const correlationId = req.headers.get(HEADER_X_CORRELATION_ID) ?? generateCorrelationId();

  if (req.method === METHOD_OPTIONS) {
    return new Response(null, {
      status: STATUS_NO_CONTENT,
      headers: getCORSHeaders(req),
    });
  }

  const url = new URL(req.url);
  const path = url.pathname.replace('/oauth', '').replace(/^\/+/, '') || '';
  const pathParts = path.split('/').filter((p) => p);

  if (pathParts.length === 0 || pathParts[0] === '') {
    if (url.pathname.includes('/oauth-handler')) {
      const legacyPath = url.pathname.replace('/oauth-handler', '').replace(/^\/+/, '') || '';
      if (legacyPath === 'authorize' && req.method === METHOD_GET) {
        return handleShopifyAuthorize(req);
      }
      if (legacyPath === 'callback' && req.method === METHOD_GET) {
        return handleShopifyCallback(req);
      }
      if (legacyPath === 'refresh' && req.method === METHOD_GET) {
        return handleShopifyRefresh(req);
      }
    }

    if (url.pathname.includes('/google-oauth')) {
      const legacyPath = url.pathname.replace('/google-oauth', '').replace(/^\/+/, '') || '';
      if (legacyPath.includes('/authorize') && req.method === METHOD_GET) {
        return handleGoogleAuthorize(req);
      }
      if (legacyPath.includes('/callback') && req.method === METHOD_GET) {
        return handleGoogleCallback(req);
      }
      if (legacyPath.includes('/refresh') && req.method === METHOD_POST) {
        return handleGoogleRefresh(req);
      }
    }
  }

  if (pathParts.length >= 2) {
    const provider = pathParts[0];
    const action = pathParts[1];

    if (provider === 'shopify') {
      if (action === 'authorize' && req.method === METHOD_GET) {
        return handleShopifyAuthorize(req);
      }
      if (action === 'callback' && req.method === METHOD_GET) {
        return handleShopifyCallback(req);
      }
      if (action === 'refresh' && req.method === METHOD_GET) {
        return handleShopifyRefresh(req);
      }
    }

    if (provider === 'google') {
      if (action === 'authorize' && req.method === METHOD_GET) {
        return handleGoogleAuthorize(req);
      }
      if (action === 'callback' && req.method === METHOD_GET) {
        return handleGoogleCallback(req);
      }
      if (action === 'refresh' && req.method === METHOD_POST) {
        return handleGoogleRefresh(req);
      }
    }
  }

  return createErrorResponse(ERROR_NOT_FOUND, STATUS_NOT_FOUND, correlationId, req);
}

serve(routeRequest);
