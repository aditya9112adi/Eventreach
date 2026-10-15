
import axios, { type AxiosResponse } from 'axios';
import { WhatsAppSender } from '../models/WhatsAppSender';
import {
  isSenderStatusFresh,
  SENDER_STATUS_FRESHNESS_MS,
} from './whatsappSenderPolicy';

export interface MetaPhoneNumber {
  id: string;
  display_phone_number: string;
  verified_name: string;
  quality_rating?: string | null;
  status?: string | null;
}

export interface MetaSenderClient {
  listPhoneNumbers(wabaId: string): Promise<MetaPhoneNumber[]>;
  getPhoneNumberStatus(phoneNumberId: string): Promise<string | null>;
}

export { isSenderStatusFresh, SENDER_STATUS_FRESHNESS_MS } from './whatsappSenderPolicy';

const apiVersion = () =>
  (process.env.WHATSAPP_API_VERSION || 'v22.0').trim();

/**
 * Only Meta's Graph API host may receive the access token. A paging link is
 * taken from Meta's response, so it is checked before it is followed.
 */
export const isMetaGraphUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'graph.facebook.com';
  } catch {
    return false;
  }
};

/** Live adapter is only invoked by an explicit SuperAdmin sync/status request. */
export const metaSenderClient: MetaSenderClient = {
  async listPhoneNumbers(wabaId) {
    const token = process.env.WHATSAPP_TOKEN?.trim();

    if (!token) {
      throw new Error('WhatsApp access token is not configured.');
    }

    const results: MetaPhoneNumber[] = [];
    let url: string | undefined =
      `https://graph.facebook.com/${apiVersion()}/${encodeURIComponent(wabaId)}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,status&limit=100`;

    // Follow only Meta's returned paging URL; cap pages to avoid an unbounded loop.
    for (let page = 0; url && page < 20; page += 1) {
      const response: AxiosResponse<{
        data?: MetaPhoneNumber[];
        paging?: { next?: string };
      }> = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 15000,
      });

      const data: {
        data?: MetaPhoneNumber[];
        paging?: { next?: string };
      } = response.data || {};

      if (Array.isArray(data.data)) {
        results.push(...data.data);
      }

      url =
        typeof data.paging?.next === 'string'
          ? data.paging.next
          : undefined;

      if (url && !isMetaGraphUrl(url)) {
        throw new Error(
          'Meta returned an unexpected paging link; sync was not completed.'
        );
      }
    }

    if (url) {
      throw new Error(
        'Meta sender pagination exceeded the safety limit; sync was not completed.'
      );
    }

    return results;
  },

  async getPhoneNumberStatus(phoneNumberId) {
    const token = process.env.WHATSAPP_TOKEN?.trim();

    if (!token) {
      throw new Error('WhatsApp access token is not configured.');
    }

    const response = await axios.get(
      `https://graph.facebook.com/${apiVersion()}/${encodeURIComponent(phoneNumberId)}?fields=status`,
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 15000,
      }
    );

    return typeof response.data?.status === 'string'
      ? response.data.status
      : null;
  },
};

/** Sync only IDs returned by Meta; never creates a sender from user-entered phone data. */
/**
 * A status client that asks Meta with a given token - a connected number's own
 * business token, which is the only credential that can see a number in that
 * business's WhatsApp Business Account. It can only read a number's status.
 */
export const createTokenStatusClient = (token: string): MetaSenderClient => ({
  async listPhoneNumbers() {
    throw new Error('Listing is not available with a business token.');
  },
  async getPhoneNumberStatus(phoneNumberId) {
    const response = await axios.get(
      `https://graph.facebook.com/${apiVersion()}/${encodeURIComponent(phoneNumberId)}?fields=status`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
    );
    return typeof response.data?.status === 'string' ? response.data.status : null;
  },
});

export const syncWhatsAppSenders = async (
  client: MetaSenderClient = metaSenderClient,
  configuredWabaId = process.env.WHATSAPP_WABA_ID?.trim()
) => {
  if (!configuredWabaId) {
    throw new Error('WHATSAPP_WABA_ID is not configured.');
  }

  const discovered = await client.listPhoneNumbers(configuredWabaId);
  const seen = new Set<string>();
  const now = new Date();
  let upserted = 0;

  for (const phone of discovered) {
    if (!phone?.id || !phone.display_phone_number || !phone.verified_name) {
      continue;
    }

    seen.add(String(phone.id));

    await WhatsAppSender.updateOne(
      { phoneNumberId: String(phone.id) },
      {
        $set: {
          wabaId: configuredWabaId,
          displayPhoneNumber: String(phone.display_phone_number),
          verifiedName: String(phone.verified_name),
          qualityRating: phone.quality_rating ?? null,
          ...(typeof phone.status === 'string'
            ? { metaStatus: phone.status, statusCheckedAt: now }
            : {}),
          listedInMeta: true,
          lastSyncedAt: now,
        },
        $setOnInsert: {
          enabled: false,
          allowedAdminIds: [],
        },
      },
      { upsert: true, runValidators: true }
    );

    upserted += 1;
  }

  // Missing entries are marked unlisted, never deleted; keep their audit history and assignments.
  await WhatsAppSender.updateMany(
    {
      wabaId: configuredWabaId,
      phoneNumberId: { $nin: [...seen] },
    },
    {
      $set: {
        listedInMeta: false,
        lastSyncedAt: now,
      },
    }
  );

  return {
    discovered: seen.size,
    upserted,
    missingMarkedUnlisted: true,
    syncedAt: now,
  };
};

const statusRefreshesInFlight = new Map<
  string,
  Promise<string | null>
>();
const statusRefreshAttemptAt = new Map<string, number>();

export const refreshSenderStatusIfStale = async (
  sender: {
    phoneNumberId: string;
    metaStatus?: string | null;
    statusCheckedAt?: Date | null;
  },
  client: MetaSenderClient = metaSenderClient,
  now = Date.now()
): Promise<string | null> => {
  if (isSenderStatusFresh(sender.statusCheckedAt, now)) {
    return sender.metaStatus ?? null;
  }

  const current = statusRefreshesInFlight.get(sender.phoneNumberId);

  if (current) {
    return current;
  }

  const lastAttempt = statusRefreshAttemptAt.get(sender.phoneNumberId);

  if (
    lastAttempt !== undefined &&
    now - lastAttempt < SENDER_STATUS_FRESHNESS_MS
  ) {
    throw new Error(
      'Sender status refresh is cooling down; refusing to trust stale status.'
    );
  }

  return runStatusRefresh(sender.phoneNumberId, client, now);
};

/**
 * One status request to Meta for a sender, recorded with the time it was
 * made. Concurrent callers share the request that is already in flight.
 */
const runStatusRefresh = async (
  phoneNumberId: string,
  client: MetaSenderClient,
  now: number
): Promise<string | null> => {
  statusRefreshAttemptAt.set(phoneNumberId, now);

  const refresh = (async () => {
    const status = await client.getPhoneNumberStatus(phoneNumberId);

    await WhatsAppSender.updateOne(
      { phoneNumberId },
      {
        $set: {
          metaStatus: status,
          statusCheckedAt: new Date(now),
        },
      }
    );

    return status;
  })();

  statusRefreshesInFlight.set(phoneNumberId, refresh);

  try {
    return await refresh;
  } finally {
    if (statusRefreshesInFlight.get(phoneNumberId) === refresh) {
      statusRefreshesInFlight.delete(phoneNumberId);
    }
  }
};

/** A manual refresh asks Meta at most this often per sender. */
export const MANUAL_REFRESH_COOLDOWN_MS = 60 * 1000;

export type ForcedRefreshResult =
  | { refreshed: true; status: string | null }
  | { refreshed: false; reason: 'cooldown'; retryAfterSeconds: number };

/**
 * A Super Admin's "Refresh status": asks Meta now, even if the stored status
 * is still fresh - unless Meta was asked about this sender within the last
 * minute, in which case nothing is requested and the caller is told so. A
 * request already in flight is joined rather than repeated. A failure
 * throws, leaving the stored status as it was.
 */
export const forceRefreshSenderStatus = async (
  sender: { phoneNumberId: string },
  client: MetaSenderClient = metaSenderClient,
  now = Date.now()
): Promise<ForcedRefreshResult> => {
  const current = statusRefreshesInFlight.get(sender.phoneNumberId);
  if (current) {
    return { refreshed: true, status: await current };
  }

  const lastAttempt = statusRefreshAttemptAt.get(sender.phoneNumberId);
  if (lastAttempt !== undefined && now - lastAttempt < MANUAL_REFRESH_COOLDOWN_MS) {
    return {
      refreshed: false,
      reason: 'cooldown',
      retryAfterSeconds: Math.max(1, Math.ceil((lastAttempt + MANUAL_REFRESH_COOLDOWN_MS - now) / 1000)),
    };
  }

  return { refreshed: true, status: await runStatusRefresh(sender.phoneNumberId, client, now) };
};
