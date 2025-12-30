import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import {
  getSupabaseClient,
  logger,
  UtilsError,
} from '../_shared/utils.ts';

interface DenoEnv {
  readonly get?: (key: string) => string | undefined;
}

interface DenoGlobal {
  readonly Deno?: {
    readonly env?: DenoEnv;
  };
}

interface GoogleOAuthSession {
  readonly state: string;
  readonly store_id: string;
  readonly integration_type: string;
  readonly property_id?: string;
  readonly site_url?: string;
  readonly expires_at: string;
}

const ENV_SUPABASE_URL = 'SUPABASE_URL';
const ENV_SUPABASE_SERVICE_ROLE_KEY = 'SUPABASE_SERVICE_ROLE_KEY';
const ENV_GOOGLE_CLIENT_ID = 'GOOGLE_CLIENT_ID';
const ENV_GOOGLE_CLIENT_SECRET = 'GOOGLE_CLIENT_SECRET';
const ENV_APP_URL = 'APP_URL';

const GOOGLE_OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

const GA4_SCOPES = 'https://www.googleapis.com/auth/analytics.readonly';
const GSC_SCOPES = 'https://www.googleapis.com/auth/webmasters.readonly';

const METHOD_GET = 'GET';
const METHOD_POST = 'POST';
const METHOD_OPTIONS = 'OPTIONS';
const STATUS_OK = 200;
const STATUS_BAD_REQUEST = 400;
const STATUS_UNAUTHORIZED = 401;
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

const corsHeaders: Readonly<Record<string, string>> = {
  [HEADER_ACCESS_CONTROL_ALLOW_ORIGIN]: '*',
  [HEADER_ACCESS_CONTROL_ALLOW_HEADERS]: CORS_HEADERS_VALUE,
  [HEADER_ACCESS_CONTROL_ALLOW_METHODS]: CORS_METHODS_VALUE,
  [HEADER_ACCESS_CONTROL_MAX_AGE]: CORS_MAX_AGE_VALUE,
};

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
  GOOGLE_CLIENT_ID: getEnv(ENV_GOOGLE_CLIENT_ID, ''),
  GOOGLE_CLIENT_SECRET: getEnv(ENV_GOOGLE_CLIENT_SECRET, ''),
  APP_URL: getEnv(ENV_APP_URL, ''),
};

function generateRandomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

async function handleOAuthAuthorize(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const storeId = url.searchParams.get('storeId');
  const integrationType = url.searchParams.get('integrationType') as 'google_analytics_4' | 'google_search_console' | null;
  const propertyId = url.searchParams.get('propertyId');
  const siteUrl = url.searchParams.get('siteUrl');

  if (!storeId || !integrationType) {
    return new Response(
      JSON.stringify({ error: 'storeId and integrationType are required' }),
      {
        status: STATUS_BAD_REQUEST,
        headers: { ...corsHeaders, [HEADER_CONTENT_TYPE]: HEADER_CONTENT_TYPE_JSON },
      },
    );
  }

  if (integrationType !== 'google_analytics_4' && integrationType !== 'google_search_console') {
    return new Response(
      JSON.stringify({ error: 'integrationType must be google_analytics_4 or google_search_console' }),
      {
        status: STATUS_BAD_REQUEST,
        headers: { ...corsHeaders, [HEADER_CONTENT_TYPE]: HEADER_CONTENT_TYPE_JSON },
      },
    );
  }

  try {
    const supabase = await getSupabaseClient({
      clientType: 'service',
    });

    const state = generateRandomString(32);
    const redirectUri = `${CONFIG.APP_URL}/functions/v1/google-oauth/callback`;
    const scopes = integrationType === 'google_analytics_4' ? GA4_SCOPES : GSC_SCOPES;

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    const { error: sessionError } = await supabase.from('google_oauth_sessions').insert({
      state,
      store_id: storeId,
      integration_type: integrationType,
      property_id: propertyId || null,
      site_url: siteUrl || null,
      expires_at: expiresAt.toISOString(),
    });

    if (sessionError) {
      logger.error('Failed to store OAuth session', { error: sessionError });
      throw new UtilsError('Failed to initialize OAuth', 'OAUTH_ERROR', STATUS_INTERNAL_ERROR);
    }

    const authUrl = new URL(GOOGLE_OAUTH_AUTH_URL);
    authUrl.searchParams.set('client_id', CONFIG.GOOGLE_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', scopes);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');

    return new Response(
      JSON.stringify({ authUrl: authUrl.toString() }),
      {
        status: STATUS_OK,
        headers: { ...corsHeaders, [HEADER_CONTENT_TYPE]: HEADER_CONTENT_TYPE_JSON },
      },
    );
  } catch (error) {
    logger.error('OAuth authorize error', { error: error instanceof Error ? error.message : String(error) });
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Internal server error' }),
      {
        status: STATUS_INTERNAL_ERROR,
        headers: { ...corsHeaders, [HEADER_CONTENT_TYPE]: HEADER_CONTENT_TYPE_JSON },
      },
    );
  }
}

async function handleOAuthCallback(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    // Return HTML page that posts error message to parent window
    const errorEscaped = error.replace(/'/g, "\\'").replace(/"/g, '&quot;');
    const appUrl = CONFIG.APP_URL.replace(/'/g, "\\'");
    const html = `
<!DOCTYPE html>
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
    return new Response(html, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/html',
      },
    });
  }

  if (!code || !state) {
    return new Response(
      JSON.stringify({ error: 'code and state are required' }),
      {
        status: STATUS_BAD_REQUEST,
        headers: { ...corsHeaders, [HEADER_CONTENT_TYPE]: HEADER_CONTENT_TYPE_JSON },
      },
    );
  }

  try {
    const supabase = await getSupabaseClient({
      clientType: 'service',
    });

    const { data: session, error: sessionError } = await supabase
      .from('google_oauth_sessions')
      .select('*')
      .eq('state', state)
      .single();

    if (sessionError || !session) {
      logger.error('OAuth session not found', { state, error: sessionError });
      return new Response(
        JSON.stringify({ error: 'Invalid or expired OAuth session' }),
        {
          status: STATUS_UNAUTHORIZED,
          headers: { ...corsHeaders, [HEADER_CONTENT_TYPE]: HEADER_CONTENT_TYPE_JSON },
        },
      );
    }

    if (new Date(session.expires_at) < new Date()) {
      return new Response(
        JSON.stringify({ error: 'OAuth session expired' }),
        {
          status: STATUS_UNAUTHORIZED,
          headers: { ...corsHeaders, [HEADER_CONTENT_TYPE]: HEADER_CONTENT_TYPE_JSON },
        },
      );
    }

    const redirectUri = `${CONFIG.APP_URL}/functions/v1/google-oauth/callback`;

    const tokenResponse = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
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
      logger.error('Token exchange failed', { error: errorText });
      throw new UtilsError('Failed to exchange code for token', 'OAUTH_ERROR', STATUS_INTERNAL_ERROR);
    }

    const tokenData = await tokenResponse.json() as {
      readonly access_token: string;
      readonly refresh_token?: string;
      readonly expires_in?: number;
      readonly scope?: string;
      readonly token_type?: string;
    };

    const credentials: {
      access_token: string;
      refresh_token?: string;
      expires_at?: string;
      property_id?: string;
      site_url?: string;
    } = {
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
      logger.error('Failed to save integration', { error: upsertError });
      throw new UtilsError('Failed to save integration', 'DATABASE_ERROR', STATUS_INTERNAL_ERROR);
    }

    await supabase.from('google_oauth_sessions').delete().eq('state', state);

    // Return HTML page that posts message to parent window (popup)
    const integrationType = session.integration_type.replace(/'/g, "\\'");
    const appUrl = CONFIG.APP_URL.replace(/'/g, "\\'");
    const html = `
<!DOCTYPE html>
<html>
<head>
  <title>OAuth Success</title>
</head>
<body>
  <script>
    // Post success message to parent window
    if (window.opener) {
      window.opener.postMessage({
        type: 'oauth-success',
        integrationType: ${JSON.stringify(integrationType)},
        success: true
      }, '*');
      window.close();
    } else {
      // Fallback: redirect if not in popup
      window.location.href = ${JSON.stringify(`${appUrl}/settings?connected=${integrationType}`)};
    }
  </script>
  <p>Authorization successful! You can close this window.</p>
</body>
</html>`;

    return new Response(html, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/html',
      },
    });
  } catch (error) {
    logger.error('OAuth callback error', { error: error instanceof Error ? error.message : String(error) });
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    const errorEscaped = errorMessage.replace(/'/g, "\\'").replace(/"/g, '&quot;');
    const appUrl = CONFIG.APP_URL.replace(/'/g, "\\'");
    const html = `
<!DOCTYPE html>
<html>
<head>
  <title>OAuth Error</title>
</head>
<body>
  <script>
    if (window.opener) {
      window.opener.postMessage({
        type: 'oauth-error',
        error: ${JSON.stringify(errorMessage)},
        success: false
      }, '*');
      window.close();
    } else {
      window.location.href = ${JSON.stringify(`${appUrl}/settings?error=oauth_failed`)};
    }
  </script>
  <p>Authorization failed: ${errorEscaped}. You can close this window.</p>
</body>
</html>`;
    return new Response(html, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/html',
      },
    });
  }
}

async function handleRefreshToken(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const storeId = url.searchParams.get('storeId');
  const integrationType = url.searchParams.get('integrationType') as 'google_analytics_4' | 'google_search_console' | null;

  if (!storeId || !integrationType) {
    return new Response(
      JSON.stringify({ error: 'storeId and integrationType are required' }),
      {
        status: STATUS_BAD_REQUEST,
        headers: { ...corsHeaders, [HEADER_CONTENT_TYPE]: HEADER_CONTENT_TYPE_JSON },
      },
    );
  }

  try {
    const supabase = await getSupabaseClient({
      clientType: 'service',
    });

    const { data: integration, error: integrationError } = await supabase
      .from('analytics_integrations')
      .select('credentials')
      .eq('store_id', storeId)
      .eq('integration_type', integrationType)
      .single();

    if (integrationError || !integration) {
      return new Response(
        JSON.stringify({ error: 'Integration not found' }),
        {
          status: STATUS_BAD_REQUEST,
          headers: { ...corsHeaders, [HEADER_CONTENT_TYPE]: HEADER_CONTENT_TYPE_JSON },
        },
      );
    }

    const credentials = integration.credentials as {
      readonly refresh_token?: string;
    };

    if (!credentials.refresh_token) {
      return new Response(
        JSON.stringify({ error: 'No refresh token available. Please reconnect the integration.' }),
        {
          status: STATUS_BAD_REQUEST,
          headers: { ...corsHeaders, [HEADER_CONTENT_TYPE]: HEADER_CONTENT_TYPE_JSON },
        },
      );
    }

    const tokenResponse = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
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
      logger.error('Token refresh failed', { error: errorText });
      return new Response(
        JSON.stringify({ error: 'Failed to refresh token' }),
        {
          status: STATUS_INTERNAL_ERROR,
          headers: { ...corsHeaders, [HEADER_CONTENT_TYPE]: HEADER_CONTENT_TYPE_JSON },
        },
      );
    }

    const tokenData = await tokenResponse.json() as {
      readonly access_token: string;
      readonly expires_in?: number;
      readonly scope?: string;
      readonly token_type?: string;
    };

    const updatedCredentials: {
      refresh_token?: string;
      access_token: string;
      expires_at?: string;
      property_id?: string;
      site_url?: string;
    } = {
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
      logger.error('Failed to update token', { error: updateError });
      return new Response(
        JSON.stringify({ error: 'Failed to update token' }),
        {
          status: STATUS_INTERNAL_ERROR,
          headers: { ...corsHeaders, [HEADER_CONTENT_TYPE]: HEADER_CONTENT_TYPE_JSON },
        },
      );
    }

    return new Response(
      JSON.stringify({ success: true }),
      {
        status: STATUS_OK,
        headers: { ...corsHeaders, [HEADER_CONTENT_TYPE]: HEADER_CONTENT_TYPE_JSON },
      },
    );
  } catch (error) {
    logger.error('Refresh token error', { error: error instanceof Error ? error.message : String(error) });
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Internal server error' }),
      {
        status: STATUS_INTERNAL_ERROR,
        headers: { ...corsHeaders, [HEADER_CONTENT_TYPE]: HEADER_CONTENT_TYPE_JSON },
      },
    );
  }
}

serve(async (req: Request) => {
  if (req.method === METHOD_OPTIONS) {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  const url = new URL(req.url);
  const path = url.pathname;

  try {
    if (path.includes('/authorize') && req.method === METHOD_GET) {
      return await handleOAuthAuthorize(req);
    }

    if (path.includes('/callback') && req.method === METHOD_GET) {
      return await handleOAuthCallback(req);
    }

    if (path.includes('/refresh') && req.method === METHOD_POST) {
      return await handleRefreshToken(req);
    }

    return new Response(
      JSON.stringify({ error: 'Not found' }),
      {
        status: 404,
        headers: { ...corsHeaders, [HEADER_CONTENT_TYPE]: HEADER_CONTENT_TYPE_JSON },
      },
    );
  } catch (error) {
    logger.error('Request error', { error: error instanceof Error ? error.message : String(error), path });
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Internal server error' }),
      {
        status: STATUS_INTERNAL_ERROR,
        headers: { ...corsHeaders, [HEADER_CONTENT_TYPE]: HEADER_CONTENT_TYPE_JSON },
      },
    );
  }
});

