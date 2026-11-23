const DEFAULT_DEV_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

export interface CorsEvaluation {
  allowed: boolean;
  origin: string | null;
  headers: Record<string, string>;
}

/**
 * Parses comma-separated ALLOWED_ORIGINS from environment variables.
 * Never permits wildcard '*' on privileged/authenticated endpoints.
 */
export function parseAllowedOrigins(rawAllowedOrigins?: string): string[] {
  const configured = (rawAllowedOrigins ?? '')
    .split(',')
    .map((item) => item.trim().replace(/\/+$/, ''))
    .filter((item) => item.length > 0 && item !== '*');

  if (configured.length > 0) {
    return Array.from(new Set(configured));
  }
  return DEFAULT_DEV_ORIGINS;
}

export function isOriginAllowed(
  requestOrigin: string | null | undefined,
  allowedOrigins: string[],
): boolean {
  if (!requestOrigin) {
    // Non-browser server-to-server or same-origin calls without an Origin header
    return true;
  }
  const normalized = requestOrigin.trim().replace(/\/+$/, '');
  return allowedOrigins.includes(normalized);
}

/**
 * Evaluates CORS policy for an incoming Request using an explicit origin allowlist.
 * If the Origin header is present and unlisted, returns allowed=false without echoing
 * Access-Control-Allow-Origin.
 */
export function evaluateCors(
  req: Request,
  rawAllowedOrigins?: string,
  allowMethods: string = 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
): CorsEvaluation {
  const originHeader = req.headers.get('origin');
  const allowedList = parseAllowedOrigins(rawAllowedOrigins);
  const allowed = isOriginAllowed(originHeader, allowedList);

  const headers: Record<string, string> = {
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': allowMethods,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Max-Age': '86400',
  };

  if (allowed && originHeader) {
    headers['Access-Control-Allow-Origin'] = originHeader.trim().replace(/\/+$/, '');
    headers['Access-Control-Allow-Credentials'] = 'true';
  }

  return {
    allowed,
    origin: originHeader,
    headers,
  };
}

export function handleCorsPreflightOrReject(
  req: Request,
  rawAllowedOrigins?: string,
  allowMethods?: string,
): { preflightOrErrorResponse: Response | null; corsHeaders: Record<string, string> } {
  const evaluation = evaluateCors(req, rawAllowedOrigins, allowMethods);

  if (!evaluation.allowed) {
    return {
      preflightOrErrorResponse: new Response(
        JSON.stringify({
          code: 'CORS_ORIGIN_FORBIDDEN',
          error: 'Origin is not in the configured ALLOWED_ORIGINS allowlist.',
        }),
        {
          status: 403,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Vary': 'Origin',
          },
        },
      ),
      corsHeaders: evaluation.headers,
    };
  }

  if (req.method === 'OPTIONS') {
    return {
      preflightOrErrorResponse: new Response(null, {
        status: 204,
        headers: evaluation.headers,
      }),
      corsHeaders: evaluation.headers,
    };
  }

  return {
    preflightOrErrorResponse: null,
    corsHeaders: evaluation.headers,
  };
}
