export interface WebhookChannelConfig {
  url: string;
  headers?: Record<string, string>;
}

export interface SmtpChannelConfig {
  host: string;
  port: number;
  secure?: boolean;
  username?: string;
  password?: string;
  from: string;
  to: string[];
}

export type DeliveryResult =
  | {
      ok: true;
      externalMessageId: string | null;
      externalThreadId: string | null;
      responseStatusCode: number | null;
    }
  | {
      ok: false;
      errorCode: string;
      errorMessage: string;
      responseStatusCode: number | null;
    };

export interface AlertDeliveryProviders {
  deliverWebhook(
    config: WebhookChannelConfig,
    payload: unknown,
    options: { timeoutMs: number; existingThreadId: string | null },
  ): Promise<DeliveryResult>;
  deliverSmtp(
    config: SmtpChannelConfig,
    payload: unknown,
    options: { timeoutMs: number; existingThreadId: string | null },
  ): Promise<DeliveryResult>;
}

export function createDefaultAlertDeliveryProviders(deps?: {
  fetchImpl?: typeof fetch;
  smtpSender?: (
    config: SmtpChannelConfig,
    body: string,
    options: { timeoutMs: number; existingThreadId: string | null },
  ) => Promise<DeliveryResult>;
}): AlertDeliveryProviders {
  const fetchImpl = deps?.fetchImpl ?? fetch;

  return {
    async deliverWebhook(config, payload, options) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs);
      try {
        const headers: Record<string, string> = {
          "content-type": "application/json",
          ...(config.headers ?? {}),
        };
        if (options.existingThreadId) {
          headers["x-quorum-thread-id"] = options.existingThreadId;
        }
        const response = await fetchImpl(config.url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        if (response.status < 200 || response.status >= 300) {
          return {
            ok: false,
            errorCode: "webhook_non_2xx",
            errorMessage: `http_${response.status}`,
            responseStatusCode: response.status,
          };
        }
        const thread =
          response.headers.get("x-quorum-thread-id") ??
          options.existingThreadId ??
          null;
        return {
          ok: true,
          externalMessageId: response.headers.get("x-quorum-message-id"),
          externalThreadId: thread,
          responseStatusCode: response.status,
        };
      } catch (error) {
        return {
          ok: false,
          errorCode: "webhook_timeout_or_network",
          errorMessage:
            error instanceof Error ? error.message : "webhook_failed",
          responseStatusCode: null,
        };
      } finally {
        clearTimeout(timer);
      }
    },

    async deliverSmtp(config, payload, options) {
      if (deps?.smtpSender) {
        return deps.smtpSender(config, JSON.stringify(payload), options);
      }
      // Minimal SMTP send via injectable/default failure unless configured.
      // Production wiring should inject a real SMTP sender; tests inject fakes.
      return {
        ok: false,
        errorCode: "smtp_not_configured",
        errorMessage: "smtp_sender_not_wired",
        responseStatusCode: null,
      };
    },
  };
}
