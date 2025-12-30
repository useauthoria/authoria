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

interface OAuthSession {
  readonly state: string;
  readonly shop_domain: string;
  readonly code_verifier?: string;
  readonly scopes: readonly string[];
  readonly redirect_uri?: string;
  readonly expires_at: string;
}

const ENV_SUPABASE_URL = 'SUPABASE_URL';
const ENV_SUPABASE_SERVICE_ROLE_KEY = 'SUPABASE_SERVICE_ROLE_KEY';
const ENV_SHOPIFY_API_KEY = 'SHOPIFY_API_KEY';
const ENV_SHOPIFY_API_SECRET = 'SHOPIFY_API_SECRET';
const ENV_APP_URL = 'APP_URL';

const REQUIRED_SCOPES = [
  'read_content',
  'write_content',
  'read_products',
  'read_orders',
  'read_customers',
];

const METHOD_GET = 'GET';
const METHOD_POST = 'POST';
const METHOD_OPTIONS = 'OPTIONS';
const STATUS_OK = 200;
const STATUS_BAD_REQUEST = 400;
const STATUS_UNAUTHORIZED = 401;
const STATUS_NOT_FOUND = 404;
const STATUS_INTERNAL_ERROR = 500;
const HEADER_CONTENT_TYPE = 'Content-Type';
const HEADER_CONTENT_TYPE_JSON = 'application/json';
const HEADER_ACCESS_CONTROL_ALLOW_ORIGIN = 'Access-Control-Allow-Origin';
const HEADER_ACCESS_CONTROL_ALLOW_HEADERS = 'Access-Control-Allow-Headers';
const HEADER_ACCESS_CONTROL_ALLOW_METHODS = 'Access-Control-Allow-Methods';
const HEADER_ACCESS_CONTROL_MAX_AGE = 'Access-Control-Max-Age';
const CORS_HEADERS_VALUE = 'authorization, x-client-info, apikey, content-type';
const CORS_METHODS_VALUE = 'GET, POST, OPTIONS';
const CORS_MAX_AGE_VALUE = '86400';

const ENV_CORS_ORIGINS = 'CORS_ORIGINS';

function getCORSHeaders(req: Request): Readonly<Record<string, string>> {
  return createCORSHeaders(req, getEnv(ENV_CORS_ORIGINS, '*').split(','));
}

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
  APP_URL: getEnv(ENV_APP_URL, ''),
};

function generateRandomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function generateCodeVerifier(): string {
  return generateRandomString(128);
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

  // Create a copy to avoid mutating the original
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

async function handleOAuthAuthorize(req: Request): Promise<Response> {
  // Rate limiting
  const rateLimit = checkRateLimit('oauth:authorize', 20, 60000); // 20 requests per minute
  if (!rateLimit.allowed) {
    return new Response(
      JSON.stringify({ error: 'Rate limit exceeded. Please try again later.' }),
      {
        status: 429,
        headers: { ...getCORSHeaders(req), [HEADER_CONTENT_TYPE]: HEADER_CONTENT_TYPE_JSON },
      },
    );
  }

  const url = new URL(req.url);
  const shop = url.searchParams.get('shop');

  if (!shop) {
    return new Response(
      JSON.stringify({ error: 'Shop parameter is required' }),
      {
        status: STATUS_BAD_REQUEST,
        headers: { ...getCORSHeaders(req), [HEADER_CONTENT_TYPE]: HEADER_CONTENT_TYPE_JSON },
      },
    );
  }

  const shopDomain = normalizeShopDomain(shop);
  if (!validateShopDomain(shopDomain)) {
    return new Response(
      JSON.stringify({ error: 'Invalid shop domain format' }),
      {
        status: STATUS_BAD_REQUEST,
        headers: { ...getCORSHeaders(req), [HEADER_CONTENT_TYPE]: HEADER_CONTENT_TYPE_JSON },
      },
    );
  }

  try {
    const supabase = await getSupabaseClient({
      clientType: 'service',
    });

    const state = generateRandomString(32);
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    const redirectUri = `${CONFIG.APP_URL}/auth/callback`;
    const scopes = REQUIRED_SCOPES.join(',');

    // Store OAuth session
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    const { error: sessionError } = await supabase.from('oauth_sessions').insert({
      state,
      shop_domain: shopDomain,
      code_verifier: codeVerifier,
      scopes: REQUIRED_SCOPES,
      redirect_uri: redirectUri,
      expires_at: expiresAt.toISOString(),
    });

    if (sessionError) {
      logger.error('Failed to store OAuth session', { error: sessionError });
      throw new UtilsError('Failed to initialize OAuth', 'OAUTH_ERROR', STATUS_INTERNAL_ERROR);
    }

    // Build Shopify OAuth URL
    const authUrl = new URL(`https://${shopDomain}/admin/oauth/authorize`);
    authUrl.searchParams.set('client_id', CONFIG.SHOPIFY_API_KEY);
    authUrl.searchParams.set('scope', scopes);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    return new Response(
      JSON.stringify({
        authUrl: authUrl.toString(),
        state,
      }),
      {
        status: STATUS_OK,
        headers: { ...getCORSHeaders(req), [HEADER_CONTENT_TYPE]: HEADER_CONTENT_TYPE_JSON },
      },
    );
  } catch (error) {
    logger.error('OAuth authorize error', {
      error: error instanceof Error ? error.message : String(error),
      shop: shopDomain,
    });
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Failed to initialize OAuth',
      }),
      {
        status: STATUS_INTERNAL_ERROR,
        headers: { ...getCORSHeaders(req), [HEADER_CONTENT_TYPE]: HEADER_CONTENT_TYPE_JSON },
      },
    );
  }
}

async function handleOAuthCallback(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const query = url.searchParams;

  // Verify HMAC
  if (!(await verifyHmac(new URLSearchParams(query), CONFIG.SHOPIFY_API_SECRET))) {
    return new Response(
      JSON.stringify({ error: 'Invalid HMAC signature' }),
      {
        status: STATUS_UNAUTHORIZED,
        headers: { ...getCORSHeaders(req), [HEADER_CONTENT_TYPE]: HEADER_CONTENT_TYPE_JSON },
      },
    );
  }

  const shop = query.get('shop');
  const code = query.get('code');
  const state = query.get('state');

  if (!shop || !code || !state) {
    return new Response(
      JSON.stringify({ error: 'Missing required parameters' }),
      {
        status: STATUS_BAD_REQUEST,
        headers: { ...getCORSHeaders(req), [HEADER_CONTENT_TYPE]: HEADER_CONTENT_TYPE_JSON },
      },
    );
  }

  const shopDomain = normalizeShopDomain(shop);

  try {
    const supabase = await getSupabaseClient({
      clientType: 'service',
    });

    // Retrieve OAuth session
    const { data: session, error: sessionError } = await supabase
      .from('oauth_sessions')
      .select('*')
      .eq('state', state)
      .eq('shop_domain', shopDomain)
      .single();

    if (sessionError || !session) {
      logger.error('OAuth session not found', { state, shopDomain, error: sessionError });
      return new Response(
        JSON.stringify({ error: 'Invalid or expired OAuth session' }),
        {
          status: STATUS_UNAUTHORIZED,
          headers: { ...getCORSHeaders(req), [HEADER_CONTENT_TYPE]: HEADER_CONTENT_TYPE_JSON },
        },
      );
    }

    // Check if session expired
    if (new Date(session.expires_at) < new Date()) {
      return new Response(
        JSON.stringify({ error: 'OAuth session expired' }),
        {
          status: STATUS_UNAUTHORIZED,
          headers: { ...getCORSHeaders(req), [HEADER_CONTENT_TYPE]: HEADER_CONTENT_TYPE_JSON },
        },
      );
    }

    // Exchange code for access token
    const tokenUrl = `https://${shopDomain}/admin/oauth/access_token`;
    const tokenResponse = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: CONFIG.SHOPIFY_API_KEY,
        client_secret: CONFIG.SHOPIFY_API_SECRET,
        code,
        code_verifier: session.code_verifier,
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      logger.error('Token exchange failed', { shopDomain, error: errorText });
      throw new UtilsError('Failed to exchange code for token', 'OAUTH_ERROR', STATUS_INTERNAL_ERROR);
    }

    const tokenData = await tokenResponse.json() as {
      readonly access_token: string;
      readonly scope: string;
    };

    // Fetch Shopify Shop ID using GraphQL API
    let shopifyStoreId: bigint | null = null;
    try {
      const graphqlUrl = `https://${shopDomain}/admin/api/2024-01/graphql.json`;
      const graphqlQuery = {
        query: `
          query {
            shop {
              id
              name
              myshopifyDomain
            }
          }
        `,
      };

      const graphqlResponse = await fetch(graphqlUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': tokenData.access_token,
        },
        body: JSON.stringify(graphqlQuery),
      });

      if (graphqlResponse.ok) {
        const graphqlData = await graphqlResponse.json() as {
          readonly data?: {
            readonly shop?: {
              readonly id?: string;
              readonly name?: string;
              readonly myshopifyDomain?: string;
            };
          };
          readonly errors?: readonly unknown[];
        };

        if (graphqlData.data?.shop?.id) {
          // Extract numeric ID from GID format: "gid://shopify/Shop/82374612938"
          const shopGid = graphqlData.data.shop.id;
          const idMatch = shopGid.match(/\/(\d+)$/);
          if (idMatch && idMatch[1]) {
            shopifyStoreId = BigInt(idMatch[1]);
            logger.info('Fetched Shopify Shop ID', {
              shopDomain,
              shopifyStoreId: shopifyStoreId.toString(),
              shopName: graphqlData.data.shop.name,
            });
          }
        } else if (graphqlData.errors) {
          logger.warn('GraphQL errors when fetching shop ID', {
            shopDomain,
            errors: graphqlData.errors,
          });
        }
      } else {
        const errorText = await graphqlResponse.text();
        logger.warn('Failed to fetch Shopify Shop ID', {
          shopDomain,
          status: graphqlResponse.status,
          error: errorText,
        });
      }
    } catch (error) {
      // Non-fatal: log but continue with OAuth flow
      logger.warn('Error fetching Shopify Shop ID', {
        shopDomain,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Get or create store
    const { data: existingStore } = await supabase
      .from('stores')
      .select('id')
      .eq('shop_domain', shopDomain)
      .single();

    const scopes = tokenData.scope.split(',').map((s) => s.trim());

    // Validate required scopes
    const missingScopes = REQUIRED_SCOPES.filter((scope) => !scopes.includes(scope));
    if (missingScopes.length > 0) {
      return new Response(
        JSON.stringify({
          error: `Missing required scopes: ${missingScopes.join(', ')}`,
        }),
        {
          status: STATUS_BAD_REQUEST,
          headers: { ...getCORSHeaders(req), [HEADER_CONTENT_TYPE]: HEADER_CONTENT_TYPE_JSON },
        },
      );
    }

    if (existingStore) {
      // Update existing store
      const updateData: Record<string, unknown> = {
        access_token: tokenData.access_token,
        oauth_scopes: scopes,
        installed_at: new Date().toISOString(),
        uninstalled_at: null,
        is_active: true,
        updated_at: new Date().toISOString(),
      };
      
      // Only update shopify_store_id if we successfully fetched it and it's not already set
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

      // Mark OAuth step as completed
      await supabase.rpc('complete_onboarding_step', {
        p_store_id: existingStore.id,
        p_step_name: 'oauth',
      });
    } else {
      // Create new store
      const { data: plan } = await supabase
        .from('plan_limits')
        .select('id')
        .eq('plan_name', 'free_trial')
        .single();

      if (!plan) {
        throw new UtilsError('Free trial plan not found', 'CONFIG_ERROR', STATUS_INTERNAL_ERROR);
      }

      const insertData: Record<string, unknown> = {
        shop_domain: shopDomain,
        access_token: tokenData.access_token,
        oauth_scopes: scopes,
        plan_id: plan.id,
        installed_at: new Date().toISOString(),
        is_active: true,
        // Don't set trial_started_at and trial_ends_at here - will be set on setup completion if needed
        // This prevents resetting trial dates when user uninstalls and reinstalls the app
      };

      // Add shopify_store_id if we successfully fetched it
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

      // Mark OAuth step as completed
      await supabase.rpc('complete_onboarding_step', {
        p_store_id: newStore.id,
        p_step_name: 'oauth',
      });
    }

    // Clean up OAuth session
    await supabase.from('oauth_sessions').delete().eq('state', state);

    // Redirect to app
    return Response.redirect(`${CONFIG.APP_URL}?shop=${shopDomain}&installed=true`, 302);
  } catch (error) {
    logger.error('OAuth callback error', {
      error: error instanceof Error ? error.message : String(error),
      shop: shopDomain,
    });
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Failed to complete OAuth',
      }),
      {
        status: STATUS_INTERNAL_ERROR,
        headers: { ...getCORSHeaders(req), [HEADER_CONTENT_TYPE]: HEADER_CONTENT_TYPE_JSON },
      },
    );
  }
}

async function routeRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace('/oauth-handler', '').replace(/^\/+/, '') || '';

  if (req.method === METHOD_OPTIONS) {
    return new Response('ok', { headers: getCORSHeaders(req) });
  }

  if (path === 'authorize' && req.method === METHOD_GET) {
    return handleOAuthAuthorize(req);
  }

  if (path === 'callback' && req.method === METHOD_GET) {
    return handleOAuthCallback(req);
  }

  if (path === 'refresh' && req.method === METHOD_GET) {
    return handleTokenRefresh(req);
  }

  return new Response(
    JSON.stringify({ error: 'Not found' }),
    {
      status: 404,
      headers: { ...getCORSHeaders(req), [HEADER_CONTENT_TYPE]: HEADER_CONTENT_TYPE_JSON },
    },
  );
}

/**
 * Handle token refresh/re-authentication for Shopify
 * Shopify tokens don't expire, but this endpoint can trigger re-authentication if needed
 */
async function handleTokenRefresh(req: Request): Promise<Response> {
  // Rate limiting
  const rateLimit = checkRateLimit('oauth:refresh', 10, 60000); // 10 requests per minute
  if (!rateLimit.allowed) {
    return new Response(
      JSON.stringify({ error: 'Rate limit exceeded. Please try again later.' }),
      {
        status: 429,
        headers: { ...getCORSHeaders(req), [HEADER_CONTENT_TYPE]: HEADER_CONTENT_TYPE_JSON },
      },
    );
  }

  const url = new URL(req.url);
  const shopDomain = url.searchParams.get('shop_domain');

  if (!shopDomain || !validateShopDomain(normalizeShopDomain(shopDomain))) {
    return new Response(
      JSON.stringify({ error: 'Valid shop_domain parameter is required' }),
      {
        status: STATUS_BAD_REQUEST,
        headers: { ...getCORSHeaders(req), [HEADER_CONTENT_TYPE]: HEADER_CONTENT_TYPE_JSON },
      },
    );
  }

  const normalizedDomain = normalizeShopDomain(shopDomain);

  try {
    const supabase = await getSupabaseClient({
      clientType: 'service',
    });

    // Check if store exists
    const { data: store, error: storeError } = await supabase
      .from('stores')
      .select('id, shop_domain, is_active')
      .eq('shop_domain', normalizedDomain)
      .single();

    if (storeError || !store) {
      return new Response(
        JSON.stringify({ error: 'Store not found' }),
        {
          status: STATUS_NOT_FOUND,
          headers: { ...getCORSHeaders(req), [HEADER_CONTENT_TYPE]: HEADER_CONTENT_TYPE_JSON },
        },
      );
    }

    // Return authorization URL to trigger re-authentication
    const authUrl = new URL(`https://${normalizedDomain}/admin/oauth/authorize`);
    authUrl.searchParams.set('client_id', CONFIG.SHOPIFY_API_KEY);
    authUrl.searchParams.set('scope', REQUIRED_SCOPES.join(','));
    authUrl.searchParams.set('redirect_uri', `${CONFIG.APP_URL}/auth/callback`);

    return new Response(
      JSON.stringify({
        message: 'Re-authentication required. Please authorize the application.',
        authUrl: authUrl.toString(),
        shopDomain: normalizedDomain,
      }),
      {
        status: STATUS_OK,
        headers: { ...getCORSHeaders(req), [HEADER_CONTENT_TYPE]: HEADER_CONTENT_TYPE_JSON },
      },
    );
  } catch (error) {
    logger.error('Token refresh error', {
      error: error instanceof Error ? error.message : String(error),
      shopDomain: normalizedDomain,
    });
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Failed to process token refresh request',
      }),
      {
        status: STATUS_INTERNAL_ERROR,
        headers: { ...getCORSHeaders(req), [HEADER_CONTENT_TYPE]: HEADER_CONTENT_TYPE_JSON },
      },
    );
  }
}

serve(routeRequest);

