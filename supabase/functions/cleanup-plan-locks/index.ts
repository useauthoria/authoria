/**
 * Cleanup job for expired plan operation locks
 * Should be run periodically (e.g., via cron) to clean up stale locks
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { getSupabaseClient, logger } from '../_shared/utils.ts';

const METHOD_POST = 'POST';
const METHOD_OPTIONS = 'OPTIONS';
const STATUS_OK = 200;
const STATUS_INTERNAL_ERROR = 500;

serve(async (req: Request) => {
  if (req.method === METHOD_OPTIONS) {
    return new Response('ok', { headers: { 'Access-Control-Allow-Origin': '*' } });
  }

  if (req.method !== METHOD_POST) {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const supabase = await getSupabaseClient({ clientType: 'service' });

    // Clean up expired locks
    const { data, error } = await supabase.rpc('cleanup_expired_locks');

    if (error) {
      logger.error('Failed to cleanup expired locks', { error: error.message });
      return new Response(
        JSON.stringify({ error: 'Failed to cleanup locks', details: error.message }),
        {
          status: STATUS_INTERNAL_ERROR,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    const deletedCount = data || 0;

    logger.info('Cleaned up expired locks', { deletedCount });

    return new Response(
      JSON.stringify({ success: true, deletedCount }),
      {
        status: STATUS_OK,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  } catch (error) {
    logger.error('Cleanup job failed', {
      error: error instanceof Error ? error.message : String(error),
    });

    return new Response(
      JSON.stringify({
        error: 'Internal server error',
        details: error instanceof Error ? error.message : String(error),
      }),
      {
        status: STATUS_INTERNAL_ERROR,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }
});

