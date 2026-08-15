/**
 * Phase 2C.4 — Provider Instance Secret Resolver
 *
 * Resolves secrets/credentials for a provider instance.
 * Secrets are NEVER stored in PostgreSQL — they're referenced by
 * configurationKey and resolved through an injectable resolver.
 *
 * Production: would use environment variables, AWS Secrets Manager,
 * HashiCorp Vault, or similar.
 * Testing: returns deterministic test credentials.
 */

import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Secret Resolution Result
// ---------------------------------------------------------------------------

/**
 * Resolved provider instance credentials.
 * This is what the client factory needs to construct a RouterOSProviderClient.
 */
export type ResolvedProviderCredentials = {
  /** RouterOS REST API endpoint, e.g., "https://192.168.1.1/rest" */
  endpoint: string;
  /** RouterOS API username */
  username: string;
  /** RouterOS API password */
  password: string;
  /** Allow self-signed TLS (default: false) */
  allowInsecureTls?: boolean;
  /** Request timeout in ms */
  timeoutMs?: number;
};

// ---------------------------------------------------------------------------
// Secret Resolver Interface
// ---------------------------------------------------------------------------

/**
 * Injectable secret resolver — maps a configurationKey to resolved credentials.
 *
 * This abstraction allows:
 *   - Production: resolve from env vars / secrets manager
 *   - Testing: return deterministic test credentials
 *
 * The resolver MUST NOT:
 *   - Log credentials
 *   - Store credentials in the database
 *   - Fall back to global/default credentials
 */
export interface ProviderInstanceSecretResolver {
  /**
   * Resolve credentials for a provider instance.
   * @param configurationKey The key referencing the secrets (e.g., "mikrotik-accra-01")
   * @param configuration Non-secret configuration from ConnectivityProviderInstance
   * @throws Error if credentials cannot be resolved
   */
  resolve(input: {
    configurationKey: string | null;
    configuration: Record<string, unknown> | null;
  }): Promise<ResolvedProviderCredentials>;
}

// ---------------------------------------------------------------------------
// Environment-based Secret Resolver (Production)
// ---------------------------------------------------------------------------

/**
 * Production secret resolver that reads from environment variables.
 *
 * Environment variable naming convention:
 *   MIKROTIK_{CONFIGURATION_KEY}_ENDPOINT
 *   MIKROTIK_{CONFIGURATION_KEY}_USERNAME
 *   MIKROTIK_{CONFIGURATION_KEY}_PASSWORD
 *
 * Example:
 *   configurationKey = "accra-01"
 *   → MIKROTIK_ACCRA-01_ENDPOINT
 *   → MIKROTIK_ACCRA-01_USERNAME
 *   → MIKROTIK_ACCRA-01_PASSWORD
 *
 * The configurationKey is uppercased and hyphens are preserved.
 * If the configurationKey contains invalid env var characters, resolution fails.
 */
export class EnvProviderInstanceSecretResolver implements ProviderInstanceSecretResolver {
  async resolve(input: {
    configurationKey: string | null;
    configuration: Record<string, unknown> | null;
  }): Promise<ResolvedProviderCredentials> {
    if (!input.configurationKey) {
      throw new Error(
        "Provider instance has no configurationKey — cannot resolve credentials. " +
        "Each provider instance must have a configurationKey that references its credentials.",
      );
    }

    // Normalize the key for env var lookup
    const envPrefix = `MIKROTIK_${input.configurationKey.toUpperCase()}`;

    const endpoint = process.env[`${envPrefix}_ENDPOINT`];
    const username = process.env[`${envPrefix}_USERNAME`];
    const password = process.env[`${envPrefix}_PASSWORD`];

    if (!endpoint) {
      throw new Error(
        `Cannot resolve RouterOS endpoint for configurationKey "${input.configurationKey}". ` +
        `Expected environment variable: ${envPrefix}_ENDPOINT`,
      );
    }
    if (!username) {
      throw new Error(
        `Cannot resolve RouterOS username for configurationKey "${input.configurationKey}". ` +
        `Expected environment variable: ${envPrefix}_USERNAME`,
      );
    }
    if (!password) {
      throw new Error(
        `Cannot resolve RouterOS password for configurationKey "${input.configurationKey}". ` +
        `Expected environment variable: ${envPrefix}_PASSWORD`,
      );
    }

    // Optional: allow insecure TLS from configuration
    const allowInsecureTls = input.configuration?.allowInsecureTls === true;

    if (allowInsecureTls && process.env.NODE_ENV === "production") {
      throw new Error("Insecure TLS is not allowed in production");
    }

    logger.info("routeros.credentials_resolved", {
      configurationKey: input.configurationKey,
      endpoint, // endpoint is not secret
      // Do NOT log username or password
    });

    return {
      endpoint,
      username,
      password,
      allowInsecureTls,
      timeoutMs: input.configuration?.timeoutMs as number | undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// Test Secret Resolver (for tests)
// ---------------------------------------------------------------------------

/**
 * Test-only secret resolver that returns deterministic credentials.
 * Allows tests to verify credential resolution without environment variables.
 */
export class TestSecretResolver implements ProviderInstanceSecretResolver {
  private readonly credentials: Map<string, ResolvedProviderCredentials> = new Map();

  /**
   * Register credentials for a specific configurationKey.
   * TEST-ONLY.
   */
  registerCredentials(configurationKey: string, credentials: ResolvedProviderCredentials): void {
    this.credentials.set(configurationKey, credentials);
  }

  /** Clear all registered credentials. TEST-ONLY. */
  clear(): void {
    this.credentials.clear();
  }

  async resolve(input: {
    configurationKey: string | null;
    configuration: Record<string, unknown> | null;
  }): Promise<ResolvedProviderCredentials> {
    if (!input.configurationKey) {
      throw new Error("Provider instance has no configurationKey — cannot resolve credentials.");
    }

    const creds = this.credentials.get(input.configurationKey);
    if (!creds) {
      throw new Error(
        `No test credentials registered for configurationKey "${input.configurationKey}". ` +
        `Use registerCredentials() to set up test credentials.`,
      );
    }

    return creds;
  }
}
