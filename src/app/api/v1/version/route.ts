/**
 * Phase 12.3.5 — API Version Contract endpoint.
 * GET /api/v1/version — returns the API version contract metadata.
 *
 * This endpoint is the canonical way for a client to discover:
 *   - The current stable API version.
 *   - All supported versions.
 *   - The breaking-change policy summary.
 *   - The deprecation status of the current version.
 *
 * The response includes the X-API-Version and X-API-Stable headers on every
 * /api/v1/* response (enforced by the version contract).
 */

import { NextRequest } from "next/server";
import { getRequestId, apiErrorResponse, apiSuccessResponse } from "@/lib/api/protocol";
import {
  CURRENT_API_VERSION,
  SUPPORTED_API_VERSIONS,
  versionHeaders,
  type DeprecationInfo,
  deprecationHeaders,
} from "@/lib/api/version";

export async function GET(req: NextRequest) {
  const requestId = getRequestId(req);
  try {
    const deprecation: DeprecationInfo = {
      deprecated: false, // v1 is not deprecated
    };

    const body = {
      currentVersion: CURRENT_API_VERSION,
      supportedVersions: SUPPORTED_API_VERSIONS,
      stable: true,
      deprecation,
      contract: {
        versionInPath: true,
        versionNegotiation: "url-path",
        breakingChangesRequire: "new-major-version",
        nonBreakingAdditions: "allowed",
        errorCodes: "stable-taxonomy",
        requestIdHeader: "x-request-id",
      },
    };

    const headers = {
      ...versionHeaders(CURRENT_API_VERSION),
      ...deprecationHeaders(deprecation),
    };

    // Attach the version headers to the success response.
    const res = apiSuccessResponse(body, requestId);
    // Add the version headers.
    for (const [key, value] of Object.entries(headers)) {
      res.headers.set(key, value);
    }
    return res;
  } catch (err) {
    return apiErrorResponse(err, requestId);
  }
}
